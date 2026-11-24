import type { Services } from '../services';

const escapeLabel = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

/**
 * Prometheus text exposition, written by hand: a dozen numbers do not justify a metrics library.
 * `towercab_provider_responses_total{status="429"}` is what the soak test watches.
 */
export function renderMetrics(services: Services): string {
  const lines: string[] = [];
  const metric = (
    name: string,
    type: 'gauge' | 'counter',
    help: string,
    samples: [Record<string, string>, number][],
  ) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const [labels, value] of samples) {
      const text = Object.entries(labels)
        .map(([k, v]) => `${k}="${escapeLabel(v)}"`)
        .join(',');
      lines.push(`${name}${text ? `{${text}}` : ''} ${value}`);
    }
  };

  const counts = services.live.counts();
  const providers = services.providers.list();
  const now = Date.now();

  metric('towercab_info', 'gauge', 'Build information.', [[{ version: services.env.version }, 1]]);
  metric('towercab_uptime_seconds', 'gauge', 'Seconds since the server started.', [
    [{}, Math.round(process.uptime())],
  ]);
  metric('towercab_ws_clients', 'gauge', 'Connected WebSocket clients.', [[{}, services.hub.clientCount]]);
  metric(
    'towercab_viewers',
    'gauge',
    'Browsers subscribed to an airport.',
    counts.map((c) => [{ airport: c.icao }, c.viewers]),
  );
  metric(
    'towercab_aircraft',
    'gauge',
    'Aircraft currently shown at an airport.',
    counts.map((c) => [{ airport: c.icao }, c.aircraft]),
  );
  metric(
    'towercab_poll_state',
    'gauge',
    'Polling state per airport: 1 for the current state.',
    counts.flatMap((c) =>
      (['active', 'idle', 'paused'] as const).map((state): [Record<string, string>, number] => [
        { airport: c.icao, state },
        c.state === state ? 1 : 0,
      ]),
    ),
  );
  metric(
    'towercab_provider_enabled',
    'gauge',
    'Whether a data source is enabled.',
    providers.map((p) => [{ provider: p.id }, p.enabled ? 1 : 0]),
  );
  metric(
    'towercab_provider_responses_total',
    'counter',
    'Upstream responses by HTTP status, or by error kind when there was no response.',
    providers.flatMap((p) =>
      [...p.outcomes].map(([status, n]): [Record<string, string>, number] => [{ provider: p.id, status }, n]),
    ),
  );
  metric(
    'towercab_provider_quota_remaining',
    'gauge',
    'Requests left in the provider quota window, where the provider reports one.',
    providers.flatMap((p): [Record<string, string>, number][] => {
      const quota = p.health().quota;
      return quota ? [[{ provider: p.id }, quota.remaining]] : [];
    }),
  );
  metric(
    'towercab_provider_backoff_seconds',
    'gauge',
    'Seconds until a failing provider is tried again.',
    providers.map((p) => {
      const until = p.health().backoffUntil;
      return [{ provider: p.id }, until ? Math.max(0, Math.round((until - now) / 1000)) : 0];
    }),
  );
  return `${lines.join('\n')}\n`;
}
