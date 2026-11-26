import { useEffect, useRef } from 'react';
import { litBars } from '../radio/level';
import type { RadioControl, RadioState } from '../radio/useRadio';

const BARS = 12;

const STATE_TEXT: Record<RadioState, string> = {
  off: 'Off',
  tuning: 'Tuning…',
  on: 'On air',
  error: 'No signal',
};

/** The signal meter: real levels when the sound can be measured, otherwise a steady light while it plays. */
function Meter({ radio }: { radio: RadioControl }) {
  const bars = useRef<HTMLSpanElement[]>([]);
  const measured = radio.state === 'on' && radio.level() !== null;

  useEffect(() => {
    if (!measured) {
      for (const bar of bars.current) bar?.classList.remove('lit');
      return;
    }
    let frame = 0;
    let shown = 0;
    const draw = () => {
      const level = radio.level() ?? 0;
      // Rises at once, falls back slowly, like the needle of a real meter.
      shown = level > shown ? level : shown * 0.9;
      const lit = litBars(shown, BARS);
      bars.current.forEach((bar, i) => {
        bar?.classList.toggle('lit', i < lit);
      });
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [measured, radio]);

  if (radio.state === 'on' && !measured) {
    return (
      <span className="radio-meter steady" aria-hidden="true">
        <span className="radio-carrier" />
      </span>
    );
  }
  return (
    <span className="radio-meter" aria-hidden="true">
      {Array.from({ length: BARS }, (_, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed row of identical bars
          key={i}
          ref={(el) => {
            if (el) bars.current[i] = el;
          }}
          className="radio-bar"
        />
      ))}
    </span>
  );
}

/**
 * A small receiver for the side panel: what is tuned, whether it is on air, play and pause, the station
 * buttons and the volume. Without a station of its own it says so and offers LiveATC's page instead.
 */
export function Radio({ radio, icao, liveatc }: { radio: RadioControl; icao: string; liveatc: string }) {
  const { station, state, stations } = radio;
  const on = state === 'on' || state === 'tuning';

  return (
    <div className={`radio radio-${station ? state : 'none'}`} data-testid="radio">
      <div className="radio-display" role="status" aria-live="polite">
        <div className="radio-line">
          <span className="radio-state">
            <span className="radio-lamp" />
            {station ? STATE_TEXT[state] : 'No feed'}
          </span>
          <span className="radio-freq">
            {station?.frequency ? `${station.frequency} MHz` : '---.--- MHz'}
          </span>
        </div>
        <div className="radio-name" title={station?.name}>
          {station ? station.name : `${icao} · no receiver`}
        </div>
        <div className="radio-line">
          <Meter radio={radio} />
          {stations.length > 1 && (
            <span className="radio-channel">
              CH {radio.index + 1}/{stations.length}
            </span>
          )}
        </div>
      </div>

      <div className="radio-controls">
        <button
          type="button"
          className="radio-step"
          aria-label="Previous station"
          title="Previous station"
          disabled={stations.length < 2}
          onClick={() => radio.step(-1)}
        >
          ◀
        </button>
        <button
          type="button"
          className={`radio-play${on ? ' on' : ''}`}
          aria-label={on ? 'Stop the radio' : station ? `Play ${station.name}` : 'No station to play'}
          title={on ? 'Stop (R)' : 'Play (R)'}
          aria-pressed={on}
          disabled={!station}
          onClick={radio.toggle}
        >
          {on ? (
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <rect x="3.5" y="3" width="3" height="10" rx="0.8" />
              <rect x="9.5" y="3" width="3" height="10" rx="0.8" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M5 3.2v9.6a.6.6 0 0 0 .9.5l7.6-4.8a.6.6 0 0 0 0-1L5.9 2.7a.6.6 0 0 0-.9.5z" />
            </svg>
          )}
        </button>
        <button
          type="button"
          className="radio-step"
          aria-label="Next station"
          title="Next station"
          disabled={stations.length < 2}
          onClick={() => radio.step(1)}
        >
          ▶
        </button>
        <label className="radio-volume">
          <span className="visually-hidden">Volume</span>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M2 6h2.5L8 3v10L4.5 10H2z" />
            {radio.volume > 0 && <path d="M10.5 5.5a3.5 3.5 0 0 1 0 5" fill="none" strokeWidth="1.4" />}
            {radio.volume > 0.5 && <path d="M12.3 3.7a6 6 0 0 1 0 8.6" fill="none" strokeWidth="1.4" />}
          </svg>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={radio.volume}
            disabled={!station}
            onChange={(event) => radio.setVolume(Number(event.target.value))}
          />
        </label>
      </div>

      {radio.error && <p className="radio-error small">{radio.error}</p>}
      {station?.attribution &&
        (station.link ? (
          <p className="radio-credit small">
            <a href={station.link} target="_blank" rel="noreferrer noopener">
              {station.attribution}
            </a>
          </p>
        ) : (
          <p className="radio-credit small muted">{station.attribution}</p>
        ))}
      {!station && (
        <p className="small">
          <span className="muted">There is no receiver for {icao} on this server. </span>
          <a href={liveatc} target="_blank" rel="noreferrer noopener" className="radio-liveatc">
            Listen on LiveATC ↗
          </a>
        </p>
      )}
    </div>
  );
}
