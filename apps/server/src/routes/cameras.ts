import { Transform } from 'node:stream';
import { type CamerasResponse, IcaoSchema } from '@towercab/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { GO2RTC_PLAYER_FILES } from '../cameras/go2rtc';
import { ProxyRefused, readText, type Upstream } from '../cameras/proxy';
import type { Services } from '../services';

const PLAYLIST_TYPE = 'application/vnd.apple.mpegurl';
const MAX_PLAYLIST_BYTES = 2 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 20 * 1024 * 1024;
const MAX_SEGMENT_BYTES = 256 * 1024 * 1024;
/** Each viewer of a proxied MJPEG camera holds a connection to the camera open; there is a limit to that. */
const MAX_LIVE_STREAMS = 12;
/** What a piece of an HLS stream may be. Anything else is not passed on. */
const MEDIA_TYPES =
  /^(video\/|audio\/|image\/|text\/vtt|application\/(octet-stream|mp4|x-mpegurl|vnd\.apple\.mpegurl))/i;

/** Passes data through and fails once more than `limit` bytes have gone by. */
function capped(limit: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      seen += chunk.length;
      if (seen > limit) done(new Error('the camera sent more data than a response of this kind may hold'));
      else done(null, chunk);
    },
  });
}

export function registerCameraRoutes(app: FastifyInstance, services: Services): void {
  const { airports, config, logger } = services;
  const { registry, proxy, windy, frames, go2rtc } = services.cameras;
  let liveStreams = 0;

  app.get<{ Params: { icao: string } }>(
    '/api/cameras/:icao',
    async (request, reply): Promise<CamerasResponse> => {
      const parsed = IcaoSchema.safeParse(request.params.icao);
      if (!parsed.success || !airports.isConfigured(parsed.data)) {
        return reply.code(404).send({
          error: 'unknown_airport',
          message: `${request.params.icao} is not a configured airport`,
        });
      }
      // Find out which iframe cameras refuse to be framed. The first request waits a moment for the
      // answer; after that it is known.
      const unknown = registry
        .publicList(parsed.data)
        .filter((c) => c.kind === 'iframe' && !c.problem && frames.cached(c.src) === undefined)
        .map((c) => frames.check(c.src));
      if (unknown.length > 0) {
        await Promise.race([
          Promise.allSettled(unknown),
          new Promise((resolve) => setTimeout(resolve, 3000)),
        ]);
      }
      void reply.header('Cache-Control', 'no-store');
      return { cameras: registry.publicList(parsed.data), go2rtc: Boolean(config.current.go2rtc.url) };
    },
  );

  // A Windy webcam's current image. The browser is sent on to Windy's own address for it, which the
  // server keeps fresh; the image itself never passes through here.
  app.get<{ Params: { id: string } }>('/api/cameras/:id/image', async (request, reply) => {
    const webcamId = registry.windyId(request.params.id);
    if (!webcamId) return reply.code(404).send({ error: 'not_found', message: 'No such camera' });
    try {
      const url = await windy.imageUrl(webcamId);
      if (!url) {
        return reply
          .code(503)
          .send({ error: 'no_image', message: 'Windy has no current image for this webcam.' });
      }
      return reply.header('Cache-Control', 'no-store').redirect(url, 302);
    } catch (err) {
      logger.warn({ camera: request.params.id, err: (err as Error).message }, 'Windy image lookup failed');
      return reply.code(502).send({ error: 'windy_unavailable', message: 'Windy did not answer.' });
    }
  });

  /** Opens something for a camera, or answers the request with the reason it cannot. */
  const open = async (
    request: FastifyRequest,
    reply: FastifyReply,
    cameraId: string,
    target: string,
  ): Promise<Upstream | null> => {
    const abort = new AbortController();
    // The viewer going away shows on the response: it closes before it was finished. (The request's own
    // "close" only says that the request has been read, which for a GET is at once.)
    reply.raw.once('close', () => {
      if (!reply.raw.writableFinished) abort.abort();
    });
    try {
      const range = typeof request.headers.range === 'string' ? request.headers.range : undefined;
      return await proxy.open(target, { range, signal: abort.signal });
    } catch (err) {
      if (abort.signal.aborted) return null;
      // The details (host names, addresses) go to the log, not to whoever is watching.
      if (err instanceof ProxyRefused) {
        logger.warn(
          { camera: cameraId, reason: err.reason, detail: err.message },
          'camera proxy refused a request',
        );
        void reply.code(403).send({
          error: 'proxy_refused',
          reason: err.reason,
          message: 'The server is not allowed to fetch this camera. See the server log.',
        });
      } else {
        logger.warn({ camera: cameraId, err: (err as Error).message }, 'camera did not answer');
        void reply.code(502).send({ error: 'camera_unreachable', message: 'The camera did not answer.' });
      }
      return null;
    }
  };

  const unexpected = (reply: FastifyReply, upstream: Upstream, cameraId: string, what: string) => {
    upstream.close();
    logger.warn(
      { camera: cameraId, status: upstream.status, type: upstream.headers['content-type'] },
      `camera proxy: ${what}`,
    );
    const status = upstream.status === 404 || upstream.status === 410 ? 404 : 502;
    return reply.code(status).send({ error: 'camera_unexpected', message: `The camera ${what}.` });
  };

  const sendPlaylist = async (reply: FastifyReply, upstream: Upstream, cameraId: string) => {
    let text: string;
    try {
      text = await readText(upstream.body, MAX_PLAYLIST_BYTES);
    } catch {
      return unexpected(reply, upstream, cameraId, 'sent a playlist that is too large');
    }
    if (!text.trimStart().startsWith('#EXTM3U')) {
      return unexpected(reply, upstream, cameraId, 'did not send an HLS playlist');
    }
    return reply
      .header('Cache-Control', 'no-store')
      .type(PLAYLIST_TYPE)
      .send(proxy.rewritePlaylist(cameraId, text, upstream.url));
  };

  // A proxied camera's own address: the playlist, the MJPEG stream, or the current snapshot.
  app.get<{ Params: { id: string } }>('/proxy/camera/:id', async (request, reply) => {
    const camera = registry.proxied(request.params.id);
    if (!camera) return reply.code(404).send({ error: 'not_found', message: 'No such proxied camera' });
    if (camera.kind === 'mjpeg' && liveStreams >= MAX_LIVE_STREAMS) {
      return reply
        .code(503)
        .send({ error: 'busy', message: 'Too many people are watching proxied cameras.' });
    }
    const upstream = await open(request, reply, camera.id, camera.source);
    if (!upstream) return reply;
    const type = String(upstream.headers['content-type'] ?? '');
    if (upstream.status !== 200) return unexpected(reply, upstream, camera.id, `answered ${upstream.status}`);

    if (camera.kind === 'hls') return sendPlaylist(reply, upstream, camera.id);

    if (camera.kind === 'snapshot') {
      if (!/^image\//i.test(type)) return unexpected(reply, upstream, camera.id, 'did not send an image');
      void reply.header('Cache-Control', 'no-store').type(type);
      const length = upstream.headers['content-length'];
      if (length) void reply.header('Content-Length', length);
      return reply.send(upstream.body.pipe(capped(MAX_SNAPSHOT_BYTES)));
    }

    // MJPEG: an endless multipart response, passed on as it comes.
    if (!/^multipart\/x-mixed-replace/i.test(type)) {
      return unexpected(reply, upstream, camera.id, 'did not send an MJPEG stream');
    }
    liveStreams += 1;
    let counted = true;
    const release = () => {
      if (counted) liveStreams -= 1;
      counted = false;
      upstream.close();
    };
    reply.raw.once('close', release);
    upstream.body.once('close', release);
    return reply.header('Cache-Control', 'no-store').type(type).send(upstream.body);
  });

  // Something a proxied HLS camera's playlist refers to. Only addresses this server wrote into such a
  // playlist and signed are accepted; a browser cannot name an address of its own.
  app.get<{ Params: { id: string }; Querystring: { u?: string; s?: string } }>(
    '/proxy/camera/:id/r',
    async (request, reply) => {
      const camera = registry.proxied(request.params.id);
      if (camera?.kind !== 'hls') {
        return reply.code(404).send({ error: 'not_found', message: 'No such proxied camera' });
      }
      const { u, s } = request.query;
      const target =
        typeof u === 'string' && /^[A-Za-z0-9_-]{1,4096}$/.test(u)
          ? Buffer.from(u, 'base64url').toString()
          : '';
      if (!target || typeof s !== 'string' || !proxy.verify(camera.id, target, s)) {
        return reply
          .code(403)
          .send({ error: 'bad_signature', message: 'This address was not issued by the server.' });
      }
      const upstream = await open(request, reply, camera.id, target);
      if (!upstream) return reply;
      if (upstream.status !== 200 && upstream.status !== 206) {
        return unexpected(reply, upstream, camera.id, `answered ${upstream.status}`);
      }
      const type = String(upstream.headers['content-type'] ?? 'application/octet-stream');
      if (/mpegurl/i.test(type) || /\.m3u8?$/i.test(upstream.url.pathname)) {
        return sendPlaylist(reply, upstream, camera.id);
      }
      if (!MEDIA_TYPES.test(type))
        return unexpected(reply, upstream, camera.id, 'sent something that is not media');
      void reply.code(upstream.status).type(type).header('Cache-Control', 'private, max-age=30');
      for (const name of ['content-length', 'content-range', 'accept-ranges'] as const) {
        const value = upstream.headers[name];
        if (value) void reply.header(name, value);
      }
      return reply.send(upstream.body.pipe(capped(MAX_SEGMENT_BYTES)));
    },
  );

  // go2rtc's own player, for `webrtc` cameras. Only these two files; see cameras/go2rtc.ts.
  app.get<{ Params: { file: string } }>('/go2rtc/:file', async (request, reply) => {
    const { file } = request.params;
    if (!(GO2RTC_PLAYER_FILES as readonly string[]).includes(file)) {
      return reply.code(404).send({ error: 'not_found' });
    }
    try {
      const body = await go2rtc.playerFile(file);
      if (body === null)
        return reply.code(404).send({ error: 'not_found', message: 'go2rtc is not configured' });
      return reply
        .type('text/javascript; charset=utf-8')
        .header('Cache-Control', 'public, max-age=600')
        .send(body);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'go2rtc did not answer');
      return reply.code(502).send({ error: 'go2rtc_unreachable', message: 'go2rtc did not answer.' });
    }
  });
}
