import { IcaoSchema } from '@towercab/shared';
import type { FastifyInstance } from 'fastify';
import { ProxyRefused } from '../cameras/proxy';
import type { Services } from '../services';

/** Every listener holds a connection to the receiver open while the radio plays; there is a limit to that. */
export const MAX_AUDIO_LISTENERS = 24;
/** What an audio stream may be. Anything else is not passed on. */
const AUDIO_TYPES = /^(audio\/|application\/ogg)/i;

/**
 * Radio stations marked `proxy: true`: the stream is fetched by the server and passed on as it comes, so that
 * a receiver on your own network can be heard from outside it. It goes through the camera proxy, with the same
 * rules: only hosts on `proxy.allowlist`, and the browser names a station, never an address.
 */
export function registerAudioRoutes(app: FastifyInstance, services: Services): void {
  const { config, logger } = services;
  const { proxy } = services.cameras;
  let listeners = 0;

  app.get<{ Params: { icao: string; index: string } }>(
    '/proxy/audio/:icao/:index',
    async (request, reply) => {
      const icao = IcaoSchema.safeParse(request.params.icao);
      const index = /^\d{1,2}$/.test(request.params.index) ? Number(request.params.index) : -1;
      const airport = icao.success ? config.current.airports.find((a) => a.icao === icao.data) : undefined;
      const station = airport?.audio[index];
      if (!airport || !station?.proxy) {
        return reply.code(404).send({ error: 'not_found', message: 'No such proxied radio station' });
      }
      if (listeners >= MAX_AUDIO_LISTENERS) {
        return reply.code(503).send({ error: 'busy', message: 'Too many people are listening right now.' });
      }
      const where = { airport: airport.icao, station: station.name };

      const abort = new AbortController();
      // The listener going away shows on the response: it closes before it was finished.
      reply.raw.once('close', () => {
        if (!reply.raw.writableFinished) abort.abort();
      });
      let upstream: Awaited<ReturnType<typeof proxy.open>>;
      try {
        upstream = await proxy.open(station.url, { signal: abort.signal });
      } catch (err) {
        if (abort.signal.aborted) return reply;
        // Host names and addresses go to the log, not to whoever is listening.
        if (err instanceof ProxyRefused) {
          logger.warn({ ...where, reason: err.reason, detail: err.message }, 'audio proxy refused a request');
          return reply.code(403).send({
            error: 'proxy_refused',
            reason: err.reason,
            message: 'The server is not allowed to fetch this station. See the server log.',
          });
        }
        logger.warn({ ...where, err: (err as Error).message }, 'radio station did not answer');
        return reply.code(502).send({ error: 'station_unreachable', message: 'The station did not answer.' });
      }

      const type = String(upstream.headers['content-type'] ?? '');
      if (upstream.status !== 200 || !AUDIO_TYPES.test(type)) {
        upstream.close();
        logger.warn(
          { ...where, status: upstream.status, type },
          'radio station did not send an audio stream',
        );
        return reply
          .code(upstream.status === 404 ? 404 : 502)
          .send({ error: 'station_unexpected', message: 'The station did not send an audio stream.' });
      }

      listeners += 1;
      let counted = true;
      const release = () => {
        if (counted) listeners -= 1;
        counted = false;
        upstream.close();
      };
      reply.raw.once('close', release);
      upstream.body.once('close', release);
      // A live stream: never stored, never cached, passed on as it comes.
      return reply.header('Cache-Control', 'no-store').type(type).send(upstream.body);
    },
  );
}
