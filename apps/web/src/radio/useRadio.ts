import type { PublicAudioStation } from '@towercab/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { levelFromSamples, savedVolume, saveVolume } from './level';

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
   * How loud the station is right now, 0 to 1. Null when it cannot be measured: a stream from another site can
   * be played, but the browser does not let the page look at its sound.
   */
  level(): number | null;
}

interface Playing {
  element: HTMLAudioElement;
  analyser: AnalyserNode | null;
  gain: GainNode | null;
  samples: Uint8Array<ArrayBuffer> | null;
  disconnect(): void;
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
  const playing = useRef<Playing | null>(null);
  const context = useRef<AudioContext | null>(null);
  const volumeRef = useRef(volume);
  volumeRef.current = volume;

  const current = Math.min(index, Math.max(0, stations.length - 1));
  const station = stations[current] ?? null;

  const stop = useCallback(() => {
    const was = playing.current;
    playing.current = null;
    if (was) {
      was.element.pause();
      // Without a source the element closes its connection; `pause` alone would keep downloading.
      was.element.removeAttribute('src');
      was.element.load();
      was.disconnect();
      if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
    }
    setState('off');
    setError(null);
  }, []);

  const start = useCallback(
    (target: PublicAudioStation) => {
      stop();
      const element = new Audio();
      element.preload = 'none';
      let analyser: AnalyserNode | null = null;
      let gain: GainNode | null = null;
      let samples: Uint8Array<ArrayBuffer> | null = null;
      let disconnect = () => {};
      // A stream through this server is on the page's own origin, so its sound can be measured for the meter.
      // One from elsewhere must not go through Web Audio: without CORS headers it would come out silent.
      if (target.proxied && typeof AudioContext !== 'undefined') {
        try {
          context.current ??= new AudioContext();
          const ctx = context.current;
          const source = ctx.createMediaElementSource(element);
          analyser = ctx.createAnalyser();
          analyser.fftSize = 1024;
          gain = ctx.createGain();
          gain.gain.value = volumeRef.current;
          source.connect(analyser);
          source.connect(gain);
          gain.connect(ctx.destination);
          samples = new Uint8Array(new ArrayBuffer(analyser.fftSize));
          void ctx.resume();
          disconnect = () => {
            source.disconnect();
            gain?.disconnect();
          };
        } catch {
          analyser = null;
          gain = null;
        }
      }
      if (!gain) element.volume = volumeRef.current;

      const mine = () => playing.current?.element === element;
      element.addEventListener('playing', () => {
        if (mine()) setState('on');
      });
      element.addEventListener('waiting', () => {
        if (mine()) setState('tuning');
      });
      const lost = (message: string) => () => {
        if (!mine()) return;
        setState('error');
        setError(message);
      };
      element.addEventListener('error', lost('No signal from this station.'));
      element.addEventListener('ended', lost('The station stopped sending.'));

      playing.current = { element, analyser, gain, samples, disconnect };
      setState('tuning');
      setError(null);
      element.src = target.src;
      element.play().catch((err: Error) => {
        if (!mine()) return;
        setState('error');
        setError(
          err.name === 'NotAllowedError'
            ? 'The browser did not allow playing. Press play again.'
            : 'No signal from this station.',
        );
      });

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
    if (playing.current) stop();
    else if (station) start(station);
  }, [station, start, stop]);

  const step = useCallback(
    (by: 1 | -1) => {
      if (stations.length < 2) return;
      const next = (current + by + stations.length) % stations.length;
      setIndex(next);
      const target = stations[next];
      if (playing.current && target) start(target);
    },
    [current, stations, start],
  );

  const setVolume = useCallback((value: number) => {
    const v = Math.min(1, Math.max(0, value));
    setVolumeState(v);
    saveVolume(v);
    const p = playing.current;
    if (p?.gain) p.gain.gain.value = v;
    else if (p) p.element.volume = v;
  }, []);

  const level = useCallback((): number | null => {
    const p = playing.current;
    if (!p?.analyser || !p.samples) return null;
    p.analyser.getByteTimeDomainData(p.samples);
    return levelFromSamples(p.samples);
  }, []);

  // A station that is no longer configured stops; leaving the airport stops the radio.
  const src = station?.src;
  useEffect(() => {
    const p = playing.current;
    if (p && src === undefined) stop();
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
