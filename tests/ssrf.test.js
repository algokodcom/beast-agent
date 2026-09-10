'use strict';

require('./setup');
const test = require('node:test');
const assert = require('node:assert');
const tools = require('../src/agent/tools');

test('SSRF: özel/ayrılmış IP aralıkları tanınır', () => {
  const privateIps = [
    '127.0.0.1', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', '0.0.0.0', '100.64.0.1', '198.18.0.1', '198.19.255.1',
    '192.0.0.1', '192.0.2.1', '203.0.113.5', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:192.168.0.1',
  ];
  for (const ip of privateIps) assert.equal(tools.isPrivateIp(ip), true, ip);
  const publicIps = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.0.1', '172.32.0.1', '11.0.0.1', '2606:4700:4700::1111'];
  for (const ip of publicIps) assert.equal(tools.isPrivateIp(ip), false, ip);
});

test('SSRF: metin + DNS çözümleme kapısı', async () => {
  assert.throws(() => tools.assertPublicHttpUrl('http://127.0.0.1:8080/x'), /engellendi/);
  assert.throws(() => tools.assertPublicHttpUrl('http://localhost/'), /engellendi/);
  assert.throws(() => tools.assertPublicHttpUrl('ftp://example.com/'), /http/);
  await assert.rejects(tools.assertPublicHostResolved('localhost'), /engellendi/);
  await assert.rejects(tools.assertPublicHostResolved('127.0.0.1'), /engellendi/);
  await assert.doesNotReject(tools.assertPublicHostResolved('8.8.8.8'));
});
