import assert from 'node:assert/strict'
import test from 'node:test'
import { load } from 'js-yaml'
import { importAwg, addAwgProxy } from '../src/lib/amneziaWg.ts'

// Public, synthetic key material; never a live tunnel.
const key = Buffer.alloc(32, 1).toString('base64')
const conf = `[Interface]
PrivateKey = ${key}
Address = 10.0.0.2/32
HeaderProtectionKey = ${key}
H1 = 100-200
I2 =
RandomTrailers = true
DisableCookies = off
ContentPaddingAddition = 0-32
[Peer]
PublicKey = ${key}
Endpoint = example.org:51820
AllowedIPs = 0.0.0.0/0
`
const base = `proxies: []
proxy-groups:
  - name: VPN
    type: select
    proxies: [DIRECT]
  # xkeen-device-groups-start
  - name: xkeen-device-node-1
    type: select
    hidden: true
    proxies: [DIRECT]
  # xkeen-device-groups-end
rules:
  # xkeen-custom-route preserved
  - IP-CIDR,192.168.0.0/16,DIRECT,no-resolve
  - MATCH,VPN
`

test('AWG 3.1 parameters and empty optional fields survive import', () => {
  const [proxy] = load(importAwg(conf).content) as any[]
  assert.equal(proxy.type, 'wireguard')
  assert.equal(proxy['amnezia-wg-option'].version, 3)
  assert.equal(proxy['amnezia-wg-option'].h1, '100-200')
  assert.equal(proxy['amnezia-wg-option'].i2, '')
  assert.equal(proxy['amnezia-wg-option']['random-trailers'], true)
  assert.equal(proxy['amnezia-wg-option']['disable-cookies'], false)
  assert.equal(proxy['amnezia-wg-option']['content-padding-addition'], '0-32')
})

test('3x-ui textual vpn URI produces the same proxy', () => {
  assert.deepEqual(importAwg('vpn://' + Buffer.from(conf).toString('base64url')), importAwg(conf))
})

test('ambiguous peers, shell hooks, duplicate fields and malformed parameters are rejected', () => {
  for (const invalid of [conf + '[Peer]\n', conf.replace('PrivateKey =', 'PostUp ='), conf.replace('51820', '99999'), conf.replace('I2 =', 'H1 ='), conf.replace('H1 = 100-200', 'H1 = bad')]) {
    assert.throws(() => importAwg(invalid))
  }
})

test('adding nodes preserves routing and device management boundaries, and avoids name collisions', () => {
  const generated = importAwg(conf).content
  const added = addAwgProxy(base, generated)
  const parsed = load(added) as any
  assert.deepEqual(parsed.rules, (load(base) as any).rules)
  for (const marker of ['xkeen-device-groups-start', 'xkeen-device-groups-end', 'xkeen-custom-route preserved']) assert.ok(added.includes(`# ${marker}\n`))
  assert.deepEqual(parsed['proxy-groups'][1].proxies, ['DIRECT'])
  assert.equal(parsed['proxy-groups'][0].proxies.at(-1), parsed.proxies[0].name)
  assert.equal((load(addAwgProxy(added, generated)) as any).proxies[1].name, parsed.proxies[0].name + ' (2)')
})
