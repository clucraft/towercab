import { describe, expect, it } from 'vitest';
import { isPublicAddress, matchRule, parseAllowlist, parseHostRule } from '../src/cameras/allowlist';

const allowed = (url: string, entries: string[]) => matchRule(new URL(url), parseAllowlist(entries)) !== null;

describe('camera proxy allowlist', () => {
  it('parses names, ports, wildcards and addresses', () => {
    expect(parseHostRule('Cams.Example.com')).toMatchObject({
      host: 'cams.example.com',
      wildcard: false,
      port: null,
      isAddress: false,
    });
    expect(parseHostRule('cams.example.com:8080')).toMatchObject({ host: 'cams.example.com', port: 8080 });
    expect(parseHostRule('*.cdn.example.com')).toMatchObject({ host: 'cdn.example.com', wildcard: true });
    expect(parseHostRule('192.168.1.20:8080')).toMatchObject({
      host: '192.168.1.20',
      port: 8080,
      isAddress: true,
    });
    expect(parseHostRule('[fd00::20]:8080')).toMatchObject({ host: 'fd00::20', port: 8080, isAddress: true });
    expect(parseHostRule('go2rtc:1984')).toMatchObject({ host: 'go2rtc', port: 1984, isAddress: false });
  });

  it('refuses entries that are not a host', () => {
    for (const bad of [
      '',
      '*',
      '*.com',
      'https://cams.example.com',
      'cams.example.com/live',
      'user@cams.example.com',
      'cams.*.example.com',
      'cams..example.com',
      '-cams.example.com',
      'cams.example.com:0',
      'cams.example.com:70000',
      'cams.example.com:http',
      '192.168.1',
      '[cams.example.com]',
    ]) {
      expect(() => parseHostRule(bad), bad).toThrow(/not a valid allowlist entry/);
    }
  });

  it('allows exactly the listed host on the listed port', () => {
    const list = ['cams.example.com', 'media.example.org:8443', '192.168.1.20:8080'];
    expect(allowed('https://cams.example.com/live/index.m3u8', list)).toBe(true);
    expect(allowed('http://cams.example.com/snap.jpg', list)).toBe(true);
    expect(allowed('https://CAMS.example.com:443/x', list)).toBe(true);
    expect(allowed('https://media.example.org:8443/x', list)).toBe(true);
    expect(allowed('http://192.168.1.20:8080/video', list)).toBe(true);

    // Another port, another host, a lookalike, an address where a name is listed, and the reverse.
    expect(allowed('https://cams.example.com:8443/x', list)).toBe(false);
    expect(allowed('https://media.example.org/x', list)).toBe(false);
    expect(allowed('https://other.example.com/x', list)).toBe(false);
    expect(allowed('https://cams.example.com.evil.test/x', list)).toBe(false);
    expect(allowed('https://evilcams.example.com/x', list)).toBe(false);
    expect(allowed('http://192.168.1.20/video', list)).toBe(false);
    expect(allowed('http://192.168.1.21:8080/video', list)).toBe(false);
  });

  it('a wildcard covers hosts below the name, not the name itself or lookalikes', () => {
    const list = ['*.cdn.example.com'];
    expect(allowed('https://a.cdn.example.com/seg1.ts', list)).toBe(true);
    expect(allowed('https://edge-7.eu.cdn.example.com/seg1.ts', list)).toBe(true);
    expect(allowed('https://cdn.example.com/seg1.ts', list)).toBe(false);
    expect(allowed('https://evilcdn.example.com/seg1.ts', list)).toBe(false);
    expect(allowed('https://a.cdn.example.com.evil.test/seg1.ts', list)).toBe(false);
  });

  it('allows nothing but http and https, and nothing at all with an empty list', () => {
    const list = ['cams.example.com'];
    expect(allowed('ftp://cams.example.com/x', list)).toBe(false);
    expect(allowed('file:///etc/passwd', list)).toBe(false);
    expect(allowed('data:text/plain,hi', list)).toBe(false);
    expect(allowed('https://cams.example.com/x', [])).toBe(false);
  });

  it('is not fooled by credentials or odd spellings in the URL', () => {
    const list = ['cams.example.com'];
    // The part before "@" is a user name, not the host.
    expect(allowed('https://cams.example.com@evil.test/x', list)).toBe(false);
    expect(allowed('https://evil.test/x?https://cams.example.com/', list)).toBe(false);
    expect(allowed('https://evil.test/x#@cams.example.com', list)).toBe(false);
    // Decimal and hexadecimal spellings of 127.0.0.1 are addresses, and no address is listed.
    expect(allowed('http://2130706433/x', list)).toBe(false);
    expect(allowed('http://0x7f.0.0.1/x', list)).toBe(false);
  });
});

describe('public address check', () => {
  it('accepts ordinary public addresses', () => {
    for (const ip of ['8.8.8.8', '93.184.216.34', '172.15.255.255', '172.32.0.1', '2606:4700:4700::1111']) {
      expect(isPublicAddress(ip), ip).toBe(true);
    }
  });

  it('refuses loopback, private, link-local, shared, multicast and reserved addresses', () => {
    for (const ip of [
      '0.0.0.0',
      '10.1.2.3',
      '100.64.0.1',
      '127.0.0.1',
      '169.254.169.254',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.55',
      '198.18.0.1',
      '224.0.0.1',
      '255.255.255.255',
      '::',
      '::1',
      'fc00::1',
      'fd12:3456::1',
      'fe80::1',
      'ff02::1',
      '2001:db8::1',
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });

  it('judges an IPv4 address carried inside IPv6 as that IPv4 address', () => {
    expect(isPublicAddress('::ffff:10.0.0.1')).toBe(false);
    expect(isPublicAddress('::ffff:a00:1')).toBe(false);
    expect(isPublicAddress('::ffff:127.0.0.1')).toBe(false);
    expect(isPublicAddress('64:ff9b::c0a8:137')).toBe(false);
    expect(isPublicAddress('::ffff:8.8.8.8')).toBe(true);
  });

  it('refuses anything that is not an address', () => {
    expect(isPublicAddress('cams.example.com')).toBe(false);
    expect(isPublicAddress('')).toBe(false);
  });
});
