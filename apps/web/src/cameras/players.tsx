import { type PublicCamera, parseYouTubeSource } from '@towercab/shared';
import { useEffect, useRef, useState } from 'react';
import { describeYouTubeError, loadYouTubeApi, type YtPlayer } from './youtube';

interface PlayerProps {
  camera: PublicCamera;
  /** Reports the shape of the picture (width / height) once it is known. */
  onAspect?(aspect: number): void;
}

/** Shown in place of a picture that cannot be had, with the way out: the camera's own page. */
function Unavailable({ camera, children }: { camera: PublicCamera; children: React.ReactNode }) {
  return (
    <div className="camera-message" role="status">
      <p>{children}</p>
      {camera.link && (
        <a className="button" href={camera.link} target="_blank" rel="noreferrer noopener">
          Open in new tab
        </a>
      )}
    </div>
  );
}

function YouTubePlayer({ camera }: PlayerProps) {
  const holder = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const source = parseYouTubeSource(camera.src);
  const videoId = source?.type === 'video' ? source.videoId : null;

  useEffect(() => {
    const element = holder.current;
    if (!element || !videoId) return;
    setError(null);
    let cancelled = false;
    let player: YtPlayer | null = null;
    // The API replaces the element it is given, so it gets one of its own inside ours.
    const target = document.createElement('div');
    element.appendChild(target);

    loadYouTubeApi()
      .then((YT) => {
        if (cancelled) return;
        player = new YT.Player(target, {
          width: '100%',
          height: '100%',
          videoId,
          playerVars: { autoplay: 1, playsinline: 1, origin: window.location.origin },
          events: {
            onReady: (event) => {
              // Browsers only start a video by themselves when it is silent.
              event.target.mute();
              event.target.playVideo();
            },
            onError: (event) => setError(describeYouTubeError(event.data)),
          },
        });
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
      try {
        player?.destroy();
      } catch {
        // The player may not have finished starting.
      }
      element.replaceChildren();
    };
  }, [videoId]);

  if (!videoId) return <Unavailable camera={camera}>This is not the id of a YouTube video.</Unavailable>;
  return (
    <>
      <div className="camera-media youtube" ref={holder} />
      {error && <Unavailable camera={camera}>{error}</Unavailable>}
    </>
  );
}

function HlsPlayer({ camera, onAspect }: PlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    setError(null);
    let cancelled = false;
    let destroy = () => {};

    import('hls.js')
      .then(({ default: Hls }) => {
        if (cancelled) return;
        if (Hls.isSupported()) {
          let hls: InstanceType<typeof Hls> | null = null;
          let restarts = 0;
          let restartTimer: ReturnType<typeof setTimeout> | undefined;
          let lastTime = -1;
          let idleChecks = 0;
          let lastProblem = '';
          let lastMediaRecovery = 0;

          const start = () => {
            restartTimer = undefined;
            hls?.destroy();
            const session = new Hls({ lowLatencyMode: true, backBufferLength: 30 });
            hls = session;
            session.on(Hls.Events.ERROR, (_event, data) => {
              console.debug(`TowerCab: HLS ${camera.id}: ${data.details}${data.fatal ? ' (fatal)' : ''}`);
              if (!data.fatal) return;
              lastProblem = data.details;
              // A decoding hiccup is usually cured in place; one that comes straight back is not.
              if (data.type === Hls.ErrorTypes.MEDIA_ERROR && Date.now() - lastMediaRecovery > 5000) {
                lastMediaRecovery = Date.now();
                session.recoverMediaError();
              } else {
                restart();
              }
            });
            session.loadSource(camera.src);
            session.attachMedia(video);
          };
          // Starting afresh is the cure for most live-stream trouble: a stream between segments, a camera
          // that restarted, a first segment with nothing in it.
          const restart = () => {
            if (cancelled || restartTimer !== undefined) return;
            restarts += 1;
            if (restarts > 8) {
              setError(`The stream is not delivering video${lastProblem ? ` (${lastProblem})` : ''}.`);
              hls?.destroy();
              hls = null;
              return;
            }
            restartTimer = setTimeout(start, Math.min(restarts * 1000, 5000));
          };
          // hls.js reports what fails outright. A stream that simply delivers nothing playable, or stops,
          // is caught here: no progress for ten seconds starts it afresh.
          const watchdog = setInterval(() => {
            if (!hls) return;
            const moved = video.currentTime !== lastTime;
            lastTime = video.currentTime;
            const pausedByViewer = video.paused && video.readyState >= 2;
            if (moved || pausedByViewer) {
              idleChecks = 0;
              if (moved) restarts = 0;
              return;
            }
            idleChecks += 1;
            if (idleChecks >= 4) {
              idleChecks = 0;
              restart();
            }
          }, 2500);

          start();
          destroy = () => {
            clearInterval(watchdog);
            clearTimeout(restartTimer);
            hls?.destroy();
          };
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
          // Safari plays HLS by itself.
          video.src = camera.src;
          destroy = () => {
            video.removeAttribute('src');
            video.load();
          };
        } else {
          setError('This browser cannot play HLS video.');
        }
      })
      .catch(() => !cancelled && setError('The video player could not be loaded.'));
    return () => {
      cancelled = true;
      destroy();
    };
  }, [camera.src, camera.id]);

  return (
    <>
      <video
        className="camera-media"
        ref={videoRef}
        muted
        autoPlay
        playsInline
        controls
        onLoadedMetadata={(e) => {
          const { videoWidth, videoHeight } = e.currentTarget;
          if (videoWidth > 0 && videoHeight > 0) onAspect?.(videoWidth / videoHeight);
        }}
      />
      {error && <Unavailable camera={camera}>{error}</Unavailable>}
    </>
  );
}

function MjpegPlayer({ camera, onAspect }: PlayerProps) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [failed, setFailed] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new stream address starts with a clean slate
  useEffect(() => {
    setFailed(false);
    const img = imgRef.current;
    // An MJPEG response never ends; taking the address away is what closes the connection.
    return () => {
      if (img) img.src = '';
    };
  }, [camera.src]);

  if (failed) return <Unavailable camera={camera}>The camera stream could not be loaded.</Unavailable>;
  return (
    <img
      className="camera-media"
      ref={imgRef}
      src={camera.src}
      alt={camera.name}
      onLoad={(e) => {
        const { naturalWidth, naturalHeight } = e.currentTarget;
        if (naturalWidth > 0 && naturalHeight > 0) onAspect?.(naturalWidth / naturalHeight);
      }}
      onError={() => setFailed(true)}
    />
  );
}

/** Adds a changing parameter so the browser fetches the image again instead of showing its copy. */
function withCacheBuster(src: string, n: number): string {
  return `${src}${src.includes('?') ? '&' : '?'}_=${n}`;
}

function SnapshotPlayer({ camera, onAspect }: PlayerProps) {
  const [shown, setShown] = useState<{ src: string; width: number; height: number } | null>(null);
  const [failures, setFailures] = useState(0);
  const windy = camera.provider === 'windy';

  // biome-ignore lint/correctness/useExhaustiveDependencies: `onAspect` is a reporter, not an input
  useEffect(() => {
    setShown(null);
    setFailures(0);
    let cancelled = false;
    let count = 0;
    const load = () => {
      count += 1;
      // The next picture is fetched off screen and swapped in when complete, so the view never blanks.
      const next = new Image();
      const src = withCacheBuster(camera.src, Date.now() + count);
      next.onload = () => {
        if (cancelled) return;
        setShown({ src, width: next.naturalWidth, height: next.naturalHeight });
        setFailures(0);
        if (next.naturalWidth > 0 && next.naturalHeight > 0)
          onAspect?.(next.naturalWidth / next.naturalHeight);
      };
      next.onerror = () => !cancelled && setFailures((n) => n + 1);
      next.src = src;
    };
    load();
    const timer = setInterval(load, Math.max(2, camera.refreshSeconds) * 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [camera.src, camera.refreshSeconds]);

  if (!shown) {
    return failures > 0 ? (
      <Unavailable camera={camera}>The camera picture could not be loaded.</Unavailable>
    ) : (
      <div className="camera-message muted">Loading the picture…</div>
    );
  }
  const image = (
    <img
      className="camera-media"
      src={shown.src}
      alt={camera.name}
      // Windy's terms: its pictures are shown at their own size or smaller, never enlarged.
      style={windy ? { maxWidth: shown.width, maxHeight: shown.height } : undefined}
    />
  );
  return (
    <>
      {/* Windy's terms: every picture links to the webcam's page. */}
      {windy && camera.link ? (
        <a className="camera-media-link" href={camera.link} target="_blank" rel="noreferrer noopener">
          {image}
        </a>
      ) : (
        image
      )}
      {failures >= 3 && <span className="camera-stale">not updating</span>}
    </>
  );
}

function IframePlayer({ camera }: PlayerProps) {
  const [slow, setSlow] = useState(false);
  const loaded = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: restart the wait when the page changes
  useEffect(() => {
    setSlow(false);
    loaded.current = false;
    // A page that refuses to be framed often gives no sign at all, only an empty box. If nothing has
    // loaded after a while, offer the link.
    const timer = setTimeout(() => setSlow(!loaded.current), 10_000);
    return () => clearTimeout(timer);
  }, [camera.src]);

  if (camera.frameBlocked) {
    return (
      <Unavailable camera={camera}>
        This site does not allow itself to be shown inside other pages.
      </Unavailable>
    );
  }
  return (
    <>
      <iframe
        className="camera-media"
        src={camera.src}
        title={camera.name}
        // The framed page may run its player, but may not navigate this page away or open dialogs.
        sandbox="allow-scripts allow-same-origin allow-popups allow-presentation"
        allow="autoplay; fullscreen; picture-in-picture"
        referrerPolicy="strict-origin-when-cross-origin"
        onLoad={() => {
          loaded.current = true;
          setSlow(false);
        }}
      />
      {slow && (
        <a className="camera-hint" href={camera.link ?? camera.src} target="_blank" rel="noreferrer noopener">
          Nothing showing? Open in new tab
        </a>
      )}
    </>
  );
}

/** go2rtc's player element, once its script has been loaded from the sidecar through this server. */
interface VideoStreamElement extends HTMLElement {
  mode: string;
  src: string | URL;
}

function Go2rtcPlayer({ camera, onAspect }: PlayerProps) {
  const holder = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `onAspect` is a reporter, not an input
  useEffect(() => {
    const element = holder.current;
    if (!element) return;
    setError(null);
    let cancelled = false;
    let aspectTimer: ReturnType<typeof setInterval> | undefined;
    // The player comes from the go2rtc instance itself, so it always matches that instance's protocol.
    import(/* @vite-ignore */ `${window.location.origin}/go2rtc/video-stream.js`)
      .then(() => {
        if (cancelled) return;
        const player = document.createElement('video-stream') as VideoStreamElement;
        // WebRTC where the browser can reach go2rtc directly, otherwise video over the WebSocket.
        player.mode = 'webrtc,mse,mjpeg';
        player.src = new URL(`/go2rtc/api/ws?src=${encodeURIComponent(camera.src)}`, window.location.href);
        element.appendChild(player);
        aspectTimer = setInterval(() => {
          const video = player.querySelector('video');
          if (video && video.videoWidth > 0 && video.videoHeight > 0) {
            onAspect?.(video.videoWidth / video.videoHeight);
            clearInterval(aspectTimer);
          }
        }, 1000);
      })
      .catch(() => !cancelled && setError('The go2rtc player could not be loaded. Is go2rtc running?'));
    return () => {
      cancelled = true;
      clearInterval(aspectTimer);
      element.replaceChildren();
    };
  }, [camera.src]);

  return (
    <>
      <div className="camera-media go2rtc" ref={holder} />
      {error && <Unavailable camera={camera}>{error}</Unavailable>}
    </>
  );
}

/** Plays one camera, whatever kind it is. */
export function CameraPlayer({ camera, onAspect }: PlayerProps) {
  if (camera.problem) return <Unavailable camera={camera}>{camera.problem}</Unavailable>;
  switch (camera.kind) {
    case 'youtube':
      return <YouTubePlayer camera={camera} />;
    case 'hls':
      return <HlsPlayer camera={camera} onAspect={onAspect} />;
    case 'mjpeg':
      return <MjpegPlayer camera={camera} onAspect={onAspect} />;
    case 'snapshot':
      return <SnapshotPlayer camera={camera} onAspect={onAspect} />;
    case 'iframe':
      return <IframePlayer camera={camera} />;
    case 'webrtc':
      return <Go2rtcPlayer camera={camera} onAspect={onAspect} />;
  }
}
