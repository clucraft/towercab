import {
  type AdminCamera,
  type CameraConfig,
  type CameraKind,
  type CameraPose,
  type CameraProvider,
  type PublicCamera,
  parseYouTubeSource,
} from '@towercab/shared';
import { type AppConfig, cameraSourceProblem, WINDY_SOURCE } from '../config/schema';
import { type HostRule, parseAllowlist } from './allowlist';
import { WINDY_ATTRIBUTION } from './discovery';
import type { CameraStore } from './store';

/** One camera with everything known about it, wherever it came from. */
export interface CameraEntry {
  id: string;
  airport: string;
  name: string;
  kind: CameraKind;
  source: string;
  attribution?: string;
  link?: string;
  pose?: CameraPose;
  poseFrom?: 'config' | 'admin';
  enabled: boolean;
  refreshSeconds: number;
  proxy: boolean;
  origin: 'config' | 'discovery';
  provider?: CameraProvider;
}

export interface RegistryDeps {
  config: () => AppConfig;
  /** Null when the queue database could not be opened; config cameras still work. */
  store: CameraStore | null;
  windyAvailable: () => boolean;
  /** Whether a page refuses to be framed, when that is already known. */
  frameBlocked?: (url: string) => boolean | undefined;
}

const PROXIED_KINDS: ReadonlySet<CameraKind> = new Set(['hls', 'mjpeg', 'snapshot']);

/**
 * The cameras there are: the ones in the config file, plus the discovered ones an admin approved. This is
 * the only place that decides what a viewer's browser is told about a camera.
 */
export class CameraRegistry {
  constructor(private readonly deps: RegistryDeps) {}

  /** The parsed proxy allowlist. The config loader has already rejected entries that do not parse. */
  rules(): HostRule[] {
    try {
      return parseAllowlist(this.deps.config().proxy.allowlist);
    } catch {
      return [];
    }
  }

  /** Every camera viewers could be shown: config cameras and approved discoveries, enabled or not. */
  private entries(): CameraEntry[] {
    const poses = this.deps.store?.poses() ?? new Map<string, CameraPose>();
    const out: CameraEntry[] = [];
    const taken = new Set<string>();
    for (const c of this.deps.config().cameras) {
      taken.add(c.id);
      out.push(fromConfig(c, poses.get(c.id)));
    }
    for (const d of this.deps.store?.list({ status: 'approved' }) ?? []) {
      // A config camera with the same id wins; the config file is the more deliberate statement.
      if (taken.has(d.id)) continue;
      const pose = poses.get(d.id);
      out.push({
        id: d.id,
        airport: d.airport,
        name: d.name,
        kind: d.kind,
        source: d.source,
        attribution: d.attribution,
        link: d.link,
        pose,
        poseFrom: pose ? 'admin' : undefined,
        enabled: d.enabled,
        refreshSeconds: 60,
        proxy: false,
        origin: 'discovery',
        provider: d.provider,
      });
    }
    return out;
  }

  /** One enabled camera by id, for the routes that serve its media. */
  find(id: string): CameraEntry | null {
    return this.entries().find((c) => c.id === id && c.enabled) ?? null;
  }

  /** The camera, if the proxy may serve it: enabled, marked `proxy`, and of a kind that can be proxied. */
  proxied(id: string): CameraEntry | null {
    const camera = this.find(id);
    if (!camera?.proxy || !PROXIED_KINDS.has(camera.kind) || WINDY_SOURCE.test(camera.source)) return null;
    return camera;
  }

  /** The Windy webcam id behind an enabled camera, if that is what it is. */
  windyId(id: string): string | null {
    const camera = this.find(id);
    return camera ? (WINDY_SOURCE.exec(camera.source)?.[1] ?? null) : null;
  }

  /** Whether a go2rtc stream belongs to an enabled camera. Nothing else in go2rtc is reachable. */
  go2rtcStream(name: string): boolean {
    return this.entries().some((c) => c.enabled && c.kind === 'webrtc' && c.source === name);
  }

  /** Which outside providers have a camera on show, for the credits. */
  providersInUse(): Set<CameraProvider> {
    const out = new Set<CameraProvider>();
    for (const c of this.entries()) {
      if (!c.enabled) continue;
      if (c.kind === 'youtube') out.add('youtube');
      if (WINDY_SOURCE.test(c.source)) out.add('windy');
    }
    return out;
  }

  /** Whether any enabled camera exists, for the feature flag. */
  any(): boolean {
    return this.entries().some((c) => c.enabled);
  }

  /** What viewers get for one airport. */
  publicList(icao: string): PublicCamera[] {
    const rules = this.rules();
    const go2rtc = Boolean(this.deps.config().go2rtc.url);
    return this.entries()
      .filter((c) => c.airport === icao && c.enabled)
      .map((c) => this.toPublic(c, rules, go2rtc));
  }

  private toPublic(c: CameraEntry, rules: readonly HostRule[], go2rtc: boolean): PublicCamera {
    const out: PublicCamera = {
      id: c.id,
      airport: c.airport,
      name: c.name,
      kind: c.kind,
      src: c.source,
      attribution: c.attribution,
      link: c.link,
      pose: c.pose,
      refreshSeconds: c.refreshSeconds,
      provider: c.provider,
    };
    const hide = (problem: string): PublicCamera => ({ ...out, src: '', problem });

    // The same check the config loader makes, repeated for entries that did not come through it and for
    // an allowlist that has changed since.
    const problem = cameraSourceProblem(c, rules);
    if (problem) return hide(problem.replace(/^camera \S+:? ?/, ''));

    const windy = WINDY_SOURCE.exec(c.source)?.[1];
    if (windy) {
      if (!this.deps.windyAvailable()) return hide('This Windy webcam needs WINDY_API_KEY to be set.');
      return {
        ...out,
        src: `/api/cameras/${encodeURIComponent(c.id)}/image`,
        attribution: c.attribution ?? WINDY_ATTRIBUTION,
        provider: 'windy',
        // Windy's free tier limits how often an image changes; asking more often gains nothing.
        refreshSeconds: Math.max(60, c.refreshSeconds),
      };
    }
    if (c.kind === 'youtube') {
      // Viewers get the bare video id, whatever form of address the config used.
      const video = parseYouTubeSource(c.source);
      if (video?.type === 'video') return { ...out, src: video.videoId, provider: 'youtube' };
    }
    if (c.kind === 'webrtc' && !go2rtc) {
      return hide('This camera plays through go2rtc, and no go2rtc address is configured.');
    }
    if (c.proxy && PROXIED_KINDS.has(c.kind)) {
      // The camera's own address never leaves the server.
      return { ...out, src: `/proxy/camera/${encodeURIComponent(c.id)}` };
    }
    if (c.kind === 'iframe') {
      const blocked = this.deps.frameBlocked?.(c.source);
      if (blocked) return { ...out, frameBlocked: true, link: c.link ?? c.source };
    }
    return out;
  }

  /** Everything, for the admin page: config cameras, and the whole queue whatever its status. */
  adminList(): AdminCamera[] {
    const poses = this.deps.store?.poses() ?? new Map<string, CameraPose>();
    const out: AdminCamera[] = [];
    const taken = new Set<string>();
    for (const c of this.deps.config().cameras) {
      taken.add(c.id);
      const entry = fromConfig(c, poses.get(c.id));
      out.push({
        id: entry.id,
        airport: entry.airport,
        name: entry.name,
        kind: entry.kind,
        source: entry.source,
        attribution: entry.attribution,
        link: entry.link,
        pose: entry.pose,
        poseFrom: entry.poseFrom,
        enabled: entry.enabled,
        origin: 'config',
        status: 'approved',
      });
    }
    for (const d of this.deps.store?.list() ?? []) {
      if (taken.has(d.id)) continue;
      const pose = poses.get(d.id);
      out.push({
        id: d.id,
        airport: d.airport,
        name: d.name,
        kind: d.kind,
        source: d.source,
        attribution: d.attribution,
        link: d.link,
        pose,
        poseFrom: pose ? 'admin' : undefined,
        enabled: d.enabled,
        origin: 'discovery',
        provider: d.provider,
        status: d.status,
        thumbnail: d.thumbnail,
        detail: d.detail,
        foundAt: d.foundAt,
        lastSeenAt: d.lastSeenAt,
      });
    }
    return out;
  }
}

function fromConfig(c: CameraConfig, adminPose: CameraPose | undefined): CameraEntry {
  const pose = adminPose ?? c.pose;
  return {
    id: c.id,
    airport: c.airport,
    name: c.name,
    kind: c.kind,
    source: c.source,
    attribution: c.attribution,
    link: c.link,
    pose,
    poseFrom: adminPose ? 'admin' : c.pose ? 'config' : undefined,
    enabled: c.enabled,
    refreshSeconds: c.refreshSeconds,
    proxy: c.proxy,
    origin: 'config',
  };
}
