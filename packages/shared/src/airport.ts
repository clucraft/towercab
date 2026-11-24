import { z } from 'zod';

/** ICAO location indicator, e.g. `KLAF`. Accepts lower case and normalises to upper case. */
export const IcaoSchema = z
  .string()
  .trim()
  .transform((s) => s.toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9]{3,4}$/, 'expected a 3 or 4 character airport code'));

export const LatSchema = z.number().min(-90).max(90);
export const LonSchema = z.number().min(-180).max(180);

/** Control tower position. `heightM` is the eye height above the ground at the tower. */
export const TowerSchema = z.object({
  lat: LatSchema,
  lon: LonSchema,
  heightM: z.number().positive().max(200).optional(),
  /** True unless the position was surveyed. OSM and hand-entered values are approximate. */
  approximate: z.boolean().default(true),
});
export type Tower = z.infer<typeof TowerSchema>;

/** Outbound links shown in the side panel. All optional; sensible defaults are derived from the ICAO code. */
export const AirportLinksSchema = z.object({
  liveatc: z.url().optional(),
  diagram: z.url().optional(),
  flightaware: z.url().optional(),
});
export type AirportLinks = z.infer<typeof AirportLinksSchema>;

/**
 * One airport as written in `config.yaml`. Only `icao` is required: the reference point, elevation and
 * runways come from OurAirports, and any value given here overrides the data.
 */
export const AirportEntrySchema = z.object({
  icao: IcaoSchema,
  name: z.string().min(1).optional(),
  /** City name, used for camera discovery keywords and the UI. */
  city: z.string().min(1).optional(),
  lat: LatSchema.optional(),
  lon: LonSchema.optional(),
  elevationFt: z.number().min(-1500).max(20000).optional(),
  /** Geofence radius around the reference point. */
  radiusNm: z.number().positive().max(40).default(6),
  /** Geofence ceiling above field elevation. */
  ceilingFtAgl: z.number().positive().max(60000).default(5000),
  tower: TowerSchema.nullable().default(null),
  /** `tower`, `overhead`, `orbit` or a runway end such as `rwy-10`. */
  defaultView: z.string().min(1).default('overhead'),
  links: AirportLinksSchema.optional(),
});
export type AirportEntry = z.infer<typeof AirportEntrySchema>;
export type AirportEntryInput = z.input<typeof AirportEntrySchema>;
