import {
  type Aircraft,
  aircraftLabel,
  describeAddrType,
  PHASE_LABELS,
  resolveAircraftType,
} from '@towercab/shared';
import { useEffect, useState } from 'react';
import { type AircraftPhoto, api } from '../api';

interface Props {
  aircraft: Aircraft;
  /** The server's clock, for the data age. */
  now: number;
  photos: boolean;
  following: boolean;
  onFollow(): void;
  onClose(): void;
}

const SOURCE_NAMES: Record<string, string> = {
  readsb: 'Local receiver',
  adsbfi: 'adsb.fi',
  adsblol: 'adsb.lol',
  airplaneslive: 'airplanes.live',
  opensky: 'OpenSky Network',
  simulator: 'Simulator',
  replay: 'Recording',
};

function Row({ label, value }: { label: string; value: string | undefined }) {
  if (value === undefined || value === '') return null;
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

/** Details of the selected aircraft, with a Follow button and, when one exists, a photo. */
export function SelectionPanel({ aircraft: a, now, photos, following, onFollow, onClose }: Props) {
  const [photo, setPhoto] = useState<AircraftPhoto | null>(null);
  const type = resolveAircraftType(a.typeCode, a.category);

  useEffect(() => {
    setPhoto(null);
    if (!photos || a.hex.startsWith('~') || a.source === 'simulator') return;
    const controller = new AbortController();
    api
      .photo(a.hex, controller.signal)
      .then(setPhoto)
      .catch(() => {
        // No photo is not worth telling anyone about.
      });
    return () => controller.abort();
  }, [a.hex, a.source, photos]);

  const age = Math.max(0, (now - a.posTime) / 1000);
  const altitude = a.onGround
    ? 'On the ground'
    : a.altMslFt === undefined
      ? undefined
      : `${a.altMslFt.toLocaleString('en-US')} ft${a.aglFt === undefined ? '' : ` (${a.aglFt.toLocaleString('en-US')} ft above the field)`}`;
  const vertical =
    a.vertRateFpm === undefined || Math.abs(a.vertRateFpm) < 100
      ? undefined
      : `${a.vertRateFpm > 0 ? 'climbing' : 'descending'} ${Math.abs(a.vertRateFpm).toLocaleString('en-US')} ft/min`;

  return (
    <aside className="selection" data-testid="selection-panel" aria-label="Selected aircraft">
      <header>
        <div>
          <h2>{aircraftLabel(a)}</h2>
          <span className={`phase phase-${a.phase}`}>{PHASE_LABELS[a.phase]}</span>
        </div>
        <button type="button" className="icon" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>

      {photo && (
        <figure className="photo">
          <a href={photo.link} target="_blank" rel="noreferrer noopener">
            <img
              src={photo.thumbnail}
              alt={`${aircraftLabel(a)}, taken by ${photo.photographer}`}
              loading="lazy"
            />
          </a>
          <figcaption>
            © {photo.photographer} ·{' '}
            <a href={photo.link} target="_blank" rel="noreferrer noopener">
              planespotters.net
            </a>
          </figcaption>
        </figure>
      )}

      <dl>
        <Row label="Callsign" value={a.callsign} />
        <Row label="Registration" value={a.registration} />
        <Row label="Type" value={[a.typeCode, a.typeDesc].filter(Boolean).join(' · ') || undefined} />
        <Row label="Operator" value={a.operator} />
        <Row label="Altitude" value={altitude} />
        <Row label="Vertical" value={vertical} />
        <Row label="Ground speed" value={a.gsKt === undefined ? undefined : `${Math.round(a.gsKt)} kt`} />
        <Row
          label="Heading"
          value={
            a.headingDeg === undefined
              ? undefined
              : `${String(Math.round(a.headingDeg) % 360).padStart(3, '0')}°`
          }
        />
        <Row label="Squawk" value={a.squawk} />
        <Row label="Emergency" value={a.emergency} />
        <Row
          label="Source"
          value={`${SOURCE_NAMES[a.source] ?? a.source} · ${describeAddrType(a.addrType)}`}
        />
        <Row label="Data age" value={`${age < 10 ? age.toFixed(1) : Math.round(age)} s`} />
        <Row label="Hex" value={a.hex.toUpperCase()} />
        <Row
          label="Drawn as"
          value={`${type.class}, ${type.wingspanM.toFixed(1)} m span${type.matched === 'type' ? '' : ` (from ${type.matched === 'category' ? 'emitter category' : 'default'})`}`}
        />
      </dl>

      <button type="button" className="primary" onClick={onFollow} disabled={following}>
        {following ? 'Following' : 'Follow'}
      </button>
    </aside>
  );
}
