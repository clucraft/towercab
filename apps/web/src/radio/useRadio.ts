import { type PublicAudioStation, streamUrlNow } from '@towercab/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { savedVolume, saveVolume } from './level';
import { StreamPlayer } from './player';

export type RadioState = 'off' | 'tuning' | 'on' | 'error';

export interface RadioControl {
  stations: PublicAudioStation[];
  index: number;
  station: PublicAudioStation | null;
  state: RadioState;
  /** Why the station cannot be heard, in words for the listener. */
  error: string | null;
  volume: number;
  /** Plays the current station, or stops it. */
  toggle(): void;
  stop(): void;
  /** Moves to the next (or previous) station, and keeps playing if it was. */
  step(by: 1 | -1): void;
  setVolume(volume: number): void;
  /**
   * How loud the station is right now, 0 to 1. Null when it cannot be measured: a stream from another site that
   * does not allow being fetched can be played, but the browser does not let the page look at its sound.
   */
  level(): number | null;
}

/**
 * The radio: one live stream at a time. Stopping drops the connection rather than pausing it, so that nothing
 * is downloaded while it is off and playing again starts at the live edge, not where it stopped.
 */
export function useRadio(stations: PublicAudioStation[], airportIcao: string): RadioControl {
  const [index, setIndex] = useState(0);
  const [state, setState] = useState<RadioState>('off');
  const [error, setError] = useState<string | null>(null);
  const [volume, setVolumeState] = useState(savedVolume);
  const player = useRef<StreamPlayer | null>(null);
  const context = useRef<AudioContext | null>(null);
  const volumeRef = useRef(volume);
  volumeRef.current = volume;

  const current = Math.min(index, Math.max(0, stations.length - 1));
  const station = stations[current] ?? null;

  const stop = useCallback(() => {
    const was = player.current;
    player.current = null;
    if (was) {
      was.stop();
      if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
    }
    setState('off');
    setError(null);
  }, []);

  const start = useCallback(
    (target: PublicAudioStation) => {
      stop();
      const next: StreamPlayer = new StreamPlayer({
        url: () => streamUrlNow(target),
        sameOrigin: target.proxied,
        volume: volumeRef.current,
        context: () => {
          if (typeof AudioContext === 'undefined') return null;
          context.current ??= new AudioContext();
          return context.current;
        },
        report: (reported, message) => {
          if (player.current !== next) return;
          setState(reported);
          setError(message ?? null);
        },
      });
      player.current = next;
      next.start();

      // The phone's lock screen and the browser's media controls show the station and can stop it.
      if ('mediaSession' in navigator && typeof MediaMetadata !== 'undefined') {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: target.name,
          artist: [target.frequency, `TowerCab · ${airportIcao}`].filter(Boolean).join(' · '),
        });
        navigator.mediaSession.setActionHandler('pause', stop);
        navigator.mediaSession.setActionHandler('stop', stop);
      }
    },
    [stop, airportIcao],
  );

  const toggle = useCallback(() => {
    if (player.current) stop();
    else if (station) start(station);
  }, [station, start, stop]);

  const step = useCallback(
    (by: 1 | -1) => {
      if (stations.length < 2) return;
      const next = (current + by + stations.length) % stations.length;
      setIndex(next);
      const target = stations[next];
      if (player.current && target) start(target);
    },
    [current, stations, start],
  );

  const setVolume = useCallback((value: number) => {
    const v = Math.min(1, Math.max(0, value));
    setVolumeState(v);
    saveVolume(v);
    player.current?.setVolume(v);
  }, []);

  const level = useCallback((): number | null => player.current?.level() ?? null, []);

  // A station that is no longer configured stops; leaving the airport stops the radio.
  const src = station?.src;
  useEffect(() => {
    if (player.current && src === undefined) stop();
  }, [src, stop]);
  useEffect(
    () => () => {
      stop();
      void context.current?.close();
      context.current = null;
    },
    [stop],
  );

  return { stations, index: current, station, state, error, volume, toggle, stop, step, setVolume, level };
}
