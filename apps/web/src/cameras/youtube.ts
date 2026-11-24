/**
 * The YouTube IFrame Player API, loaded on first use. Names and behaviour as documented at
 * https://developers.google.com/youtube/iframe_api_reference (read 2026-11-24).
 */
export interface YtPlayer {
  mute(): void;
  playVideo(): void;
  destroy(): void;
}

export interface YtPlayerOptions {
  width?: string;
  height?: string;
  videoId?: string;
  playerVars?: Record<string, string | number>;
  events?: {
    onReady?(event: { target: YtPlayer }): void;
    onError?(event: { data: number }): void;
    onStateChange?(event: { data: number }): void;
  };
}

interface YtNamespace {
  Player: new (element: HTMLElement | string, options: YtPlayerOptions) => YtPlayer;
}

declare global {
  interface Window {
    YT?: YtNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

export const YOUTUBE_API_SRC = 'https://www.youtube.com/iframe_api';

let loading: Promise<YtNamespace> | null = null;

/** Loads the API script once; later calls share the same promise. */
export function loadYouTubeApi(): Promise<YtNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  loading ??= new Promise<YtNamespace>((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      if (window.YT?.Player) resolve(window.YT);
      else reject(new Error('The YouTube player did not start.'));
    };
    const script = document.createElement('script');
    script.src = YOUTUBE_API_SRC;
    script.async = true;
    script.onerror = () => {
      loading = null;
      reject(new Error('The YouTube player could not be loaded. Is youtube.com blocked here?'));
    };
    document.head.appendChild(script);
  });
  return loading;
}

/** What an `onError` code means, in words for the viewer. */
export function describeYouTubeError(code: number): string {
  switch (code) {
    case 2:
      return 'YouTube did not accept this video or channel id.';
    case 5:
      return 'YouTube could not play this stream in the browser.';
    case 100:
      return 'This video was removed or is private. A live stream gets a new id when it restarts.';
    case 101:
    case 150:
      return 'The owner of this stream does not allow it to be shown on other sites.';
    case 153:
      return 'YouTube refused to play because the page did not say where it is embedded.';
    default:
      return `YouTube reported an error (${code}).`;
  }
}
