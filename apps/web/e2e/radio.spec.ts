import { expect, test } from '@playwright/test';
import { mockBackend } from './mocks';

/** A steady tone as a WAV file, standing in for a receiver's stream: 8 kHz, 8 bit, mono. */
function toneWav(seconds: number): Buffer {
  const rate = 8000;
  const samples = rate * seconds;
  const wav = Buffer.alloc(44 + samples);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + samples, 4);
  wav.write('WAVEfmt ', 8, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate, 28);
  wav.writeUInt16LE(1, 32);
  wav.writeUInt16LE(8, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(samples, 40);
  for (let i = 0; i < samples; i += 1)
    wav[44 + i] = 128 + Math.round(60 * Math.sin((2 * Math.PI * 440 * i) / rate));
  return wav;
}

/**
 * Silent MP3, as a low-bitrate airband stream would send between transmissions: MPEG-1 Layer III frames of
 * 32 kbps, 44.1 kHz, mono, with no sound in them (104 bytes each, 26 ms).
 */
function silentMp3(seconds: number): Buffer {
  const frame = Buffer.alloc(104);
  frame.set([0xff, 0xfb, 0x10, 0xc0]);
  return Buffer.concat(Array.from({ length: Math.ceil((seconds * 44100) / 1152) }, () => frame));
}

const STATIONS = [
  {
    name: 'Purdue Tower',
    frequency: '118.300',
    src: '/proxy/audio/KLAF/0',
    proxied: true,
    attribution: 'Receiver at the field',
  },
  { name: 'Purdue Ground', frequency: '121.700', src: '/proxy/audio/KLAF/1', proxied: true },
];

test('the radio plays a station, shows it on air, changes station and stops', async ({ page }) => {
  await mockBackend(page, { airport: { audio: STATIONS } });
  const asked: string[] = [];
  const tone = toneWav(30);
  await page.route('**/proxy/audio/KLAF/*', (route) => {
    asked.push(new URL(route.request().url()).pathname);
    return route.fulfill({ status: 200, contentType: 'audio/wav', body: tone });
  });
  await page.goto('/KLAF');

  const radio = page.getByTestId('radio');
  await expect(radio).toContainText('Purdue Tower');
  await expect(radio).toContainText('118.300 MHz');
  await expect(radio).toContainText('Off');
  await expect(radio).toContainText('Receiver at the field');
  // Nothing is downloaded until someone presses play.
  expect(asked).toEqual([]);

  await radio.getByRole('button', { name: 'Play Purdue Tower' }).click();
  await expect(radio).toContainText('On air', { timeout: 15_000 });
  await expect(page.getByTestId('radio-pill')).toContainText('Purdue Tower');
  // The sound comes from this server, so the meter shows its level.
  await expect.poll(() => radio.locator('.radio-bar.lit').count(), { timeout: 10_000 }).toBeGreaterThan(0);

  await radio.getByRole('button', { name: 'Next station' }).click();
  await expect(radio).toContainText('Purdue Ground');
  await expect(radio).toContainText('121.700 MHz');
  await expect(radio).toContainText('On air', { timeout: 15_000 });
  expect(asked).toContain('/proxy/audio/KLAF/1');

  // The pill over the scene stops it, also with the side panel closed.
  await page.getByRole('button', { name: 'Hide panel' }).click();
  await page.getByTestId('radio-pill').click();
  await expect(page.getByTestId('radio-pill')).toHaveCount(0);

  // R plays and stops it from the keyboard.
  await page.keyboard.press('r');
  await expect(page.getByTestId('radio-pill')).toContainText('Purdue Ground', { timeout: 15_000 });
  await page.keyboard.press('r');
  await expect(page.getByTestId('radio-pill')).toHaveCount(0);
});

test('an MP3 stream from another site that allows it is fed in as it comes, and measured', async ({
  page,
}) => {
  await mockBackend(page, {
    airport: {
      audio: [
        {
          name: 'Elsewhere Tower',
          frequency: '120.000',
          src: 'https://radio.example.test/twr',
          proxied: false,
        },
      ],
    },
  });
  const silence = silentMp3(60);
  await page.route('https://radio.example.test/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'audio/mpeg',
      headers: { 'access-control-allow-origin': '*' },
      body: silence,
    }),
  );
  await page.goto('/KLAF');
  const radio = page.getByTestId('radio');
  await radio.getByRole('button', { name: 'Play Elsewhere Tower' }).click();
  await expect(radio).toContainText('On air', { timeout: 10_000 });
  // Fed in by the page, the sound is on the page's origin, so the meter has bars rather than a steady line.
  await expect(radio.locator('.radio-bar')).toHaveCount(12);
  await expect(radio.locator('.radio-meter.steady')).toHaveCount(0);
});

test('a stream from another site that does not allow it is played the plain way', async ({ page }) => {
  await mockBackend(page, {
    airport: {
      audio: [
        {
          name: 'Closed Tower',
          frequency: '120.000',
          src: 'https://closed.example.test/twr',
          proxied: false,
        },
      ],
    },
  });
  const tone = toneWav(30);
  await page.route('https://closed.example.test/**', (route) =>
    route.fulfill({ status: 200, contentType: 'audio/wav', body: tone }),
  );
  await page.goto('/KLAF');
  const radio = page.getByTestId('radio');
  await radio.getByRole('button', { name: 'Play Closed Tower' }).click();
  await expect(radio).toContainText('On air', { timeout: 15_000 });
  // It plays, but the page may not look at the sound: a steady line instead of bars.
  await expect(radio.locator('.radio-meter.steady')).toHaveCount(1);
});

test('a station that does not answer says so', async ({ page }) => {
  await mockBackend(page, { airport: { audio: [STATIONS[0] as (typeof STATIONS)[number]] } });
  await page.route('**/proxy/audio/KLAF/*', (route) =>
    route.fulfill({
      status: 502,
      json: { error: 'station_unreachable', message: 'The station did not answer.' },
    }),
  );
  await page.goto('/KLAF');
  const radio = page.getByTestId('radio');
  await radio.getByRole('button', { name: 'Play Purdue Tower' }).click();
  await expect(radio).toContainText('No signal', { timeout: 15_000 });
  await expect(radio).toContainText('No signal from this station.');
});

test('without a station of its own the radio offers LiveATC instead', async ({ page }) => {
  await mockBackend(page);
  await page.goto('/KLAF');
  const radio = page.getByTestId('radio');
  await expect(radio).toContainText('No feed');
  await expect(radio.getByRole('button', { name: 'No station to play' })).toBeDisabled();
  await expect(radio.getByRole('link', { name: 'Listen on LiveATC ↗' })).toHaveAttribute(
    'href',
    'https://www.liveatc.net/search/?icao=KLAF',
  );
});
