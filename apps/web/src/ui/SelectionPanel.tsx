import {
  type Aircraft,
  aircraftLabel,
  describeAddrType,
  PHASE_LABELS,
  resolveAircraftType,
} from '@towercab/shared';
import { useEffect, useState } from 'react';
import { type AircraftPhoto, api, type TypePhoto } from '../api';

interface Props {
  aircraft: Aircraft;
  /** The server's clock, for the data age. */
  now: number;
  photos: boolean;
  typePhotos: boolean;
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

type Picture = { of: 'aircraft'; photo: AircraftPhoto } | { of: 'type'; photo: TypePhoto };

/** A photo of this very aircraft if there is one, else a picture of its type, else nothing. */
function usePicture(a: Aircraft, photos: boolean, typePhotos: boolean): Picture | null {
  const [picture, setPicture] = useState<Picture | null>(null);
  const { hex, typeCode } = a;
  // Made-up aircraft and TIS-B tracks have no airframe to look up; they may still have a type. Nobody collects
  // photos of airport vehicles.
  const lookUp = photos && !hex.startsWith('~') && a.source !== 'simulator' && a.phase !== 'vehicle';

  useEffect(() => {
    setPicture(null);
    const controller = new AbortController();
    const load = async (): Promise<Picture | null> => {
      const photo = lookUp ? await api.photo(hex, controller.signal).catch(() => null) : null;
      if (photo) return { of: 'aircraft', photo };
      const type = typePhotos && typeCode ? await api.typePhoto(typeCode, controller.signal) : null;
      return type && { of: 'type', photo: type };
    };
    load()
      .then((found) => {
        if (!controller.signal.aborted) setPicture(found);
      })
      .catch(() => {
        // No picture is not worth telling anyone about.
      });
    return () => controller.abort();
  }, [hex, typeCode, lookUp, typePhotos]);

  return picture;
}

/** Every picture is shown with the credit its source asks for, and links to the page it comes from. */
function PictureFigure({ picture, label }: { picture: Picture; label: string }) {
  const [broken, setBroken] = useState(false);
  if (broken) return null;
  const { photo } = picture;
  const alt =
    picture.of === 'aircraft' ? `${label}, taken by ${picture.photo.photographer}` : picture.photo.subject;
  return (
    <figure className="photo" data-testid={`picture-${picture.of}`}>
      <a href={photo.link} target="_blank" rel="noreferrer noopener">
        <img
          src={photo.thumbnail}
          alt={alt}
          width={photo.width ?? undefined}
          height={photo.height ?? undefined}
          referrerPolicy="no-referrer"
          onError={() => setBroken(true)}
        />
      </a>
      {picture.of === 'aircraft' ? (
        <figcaption>
          © {picture.photo.photographer} ·{' '}
          <a href={photo.link} target="_blank" rel="noreferrer noopener">
            planespotters.net
          </a>
        </figcaption>
      ) : (
        <figcaption>
          <strong>{picture.photo.subject}</strong> (not this aircraft). Photo: {picture.photo.author},{' '}
          {picture.photo.licenseUrl ? (
            <a href={picture.photo.licenseUrl} target="_blank" rel="noreferrer noopener">
              {picture.photo.license}
            </a>
          ) : (
            picture.photo.license
          )}
          , via{' '}
          <a href={photo.link} target="_blank" rel="noreferrer noopener">
            Wikimedia Commons
          </a>
        </figcaption>
      )}
    </figure>
  );
}

/** Details of the selected aircraft, with a Follow button and, when there is one, a picture. */
export function SelectionPanel(props: Props) {
  const { aircraft: a, now, photos, typePhotos, following, onFollow, onClose } = props;
  const picture = usePicture(a, photos, typePhotos);
  const type = resolveAircraftType(a.typeCode, a.category);

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

      {picture && <PictureFigure key={picture.photo.thumbnail} picture={picture} label={aircraftLabel(a)} />}

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
