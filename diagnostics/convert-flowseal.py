"""Convert reviewed Flowseal TLS/443 branches, never execute Windows launchers.

Usage: python diagnostics/convert-flowseal.py RELEASE_DIR [RELEASE_DIR ...]
Output contains parameter adaptations, not a port of whole Windows launchers.
"""
import hashlib
import json
import re
import sys
from pathlib import Path


def option(line, key, default=None):
    values = re.findall(r'--' + re.escape(key) + r'=("[^"]*"|[^\s]+)', line)
    return values[-1].strip('"') if values else default


def blobs(line, key, root):
    values = re.findall(r'--' + re.escape(key) + r'=("[^"]*"|[^\s]+)', line)
    result = []
    for value in values:
        value = value.strip('"')
        if value == '^!':
            result.append('reasm_data')
        elif value.startswith('0x'):
            bytes.fromhex(value[2:])
            result.append(value)
        elif value.startswith('%BIN%'):
            name = value[5:]
            if Path(name).name != name or not name.endswith('.bin'):
                raise ValueError('Unsupported blob path')
            data = (root / 'bin' / name).read_bytes()
            # These bytes match the stock nfqws2-keenetic blobs.
            stock = {
                '936c2bee4cfb80aa3c426b2dcbcc834b3fbcd1adb17172959dc569c73a14275c': 'tls_clienthello',
                'f4589c57749f956bb30538197a521d7005f8b0a8723b4707e72405e51ddac50a': 'quic_initial',
            }
            result.append(stock.get(hashlib.sha256(data).hexdigest(), '0x' + data.hex()))
        else:
            raise ValueError('Unsupported blob ' + value)
    return result


def convert(line, root):
    methods = option(line, 'dpi-desync').split(',')
    if not set(methods) <= {'fake', 'multisplit', 'multidisorder', 'fakedsplit', 'fakeddisorder', 'hostfakesplit', 'syndata'}:
        raise ValueError('Unsupported desync method')
    fool = []
    for method in option(line, 'dpi-desync-fooling', '').split(','):
        if not method:
            continue
        if method == 'ts':
            fool.append('tcp_ts=' + option(line, 'dpi-desync-ts-increment', '-600000'))
        elif method == 'badseq':
            fool += ['tcp_seq=' + option(line, 'dpi-desync-badseq-increment', '-10000'),
                     'tcp_ack=' + option(line, 'dpi-desync-badack-increment', '-66000')]
        elif method == 'md5sig':
            fool.append('tcp_md5')
        else:
            raise ValueError('Unsupported fooling ' + method)
    ipid = ['ip_id=zero'] if option(line, 'ip-id') == 'zero' else []
    args = ['--filter-tcp=443', '--payload=' + ('empty,tls_client_hello' if 'syndata' in methods else 'tls_client_hello')]
    repeats = option(line, 'dpi-desync-repeats', '1')
    for method in methods:
        params = []
        if method == 'fake':
            tls = option(line, 'dpi-desync-fake-tls-mod', 'none')
            for blob in blobs(line, 'dpi-desync-fake-tls', root) or ['tls_clienthello']:
                params = ['blob=' + blob] + ([] if tls == 'none' else ['tls_mod=' + tls]) + fool + ipid + ['repeats=' + repeats]
                args.append('--lua-desync=fake:' + ':'.join(params))
            continue
        if method in ('multisplit', 'multidisorder', 'fakedsplit', 'fakeddisorder'):
            params.append('pos=' + option(line, 'dpi-desync-split-pos', '2'))
            overlap = option(line, 'dpi-desync-split-seqovl')
            if overlap:
                params.append('seqovl=' + overlap)
                pattern = blobs(line, 'dpi-desync-split-seqovl-pattern', root)
                if pattern:
                    params.append('seqovl_pattern=' + pattern[0])
            if method in ('fakedsplit', 'fakeddisorder'):
                if option(line, 'dpi-desync-fakedsplit-mod', 'none') not in ('none', 'altorder=0'):
                    raise ValueError('Installed Lua has no fakedsplit alternate order')
                pattern = blobs(line, 'dpi-desync-fakedsplit-pattern', root)
                params += ['pattern=' + (pattern[0] if pattern else '0x00')] + fool + ['repeats=' + repeats]
            else:
                # nfqws1 fooling applies to fakes, not the real split segments.
                params.append('tcp_ts_up')
            params += ipid
        elif method == 'hostfakesplit':
            mods = option(line, 'dpi-desync-hostfakesplit-mod', 'host=www.google.com').split(',')
            if 'altorder=1' in mods:
                raise ValueError('Installed Lua has no hostfakesplit altorder=1')
            params = [p for p in mods if p.startswith('host=')] + fool + ipid + ['repeats=' + repeats]
        elif method == 'syndata':
            params = ['blob=0x' + '00' * 16] + fool
        args.append('--lua-desync=' + method + (':' + ':'.join(params) if params else ''))
    return '\n'.join(args) + '\n'


def main():
    entries, skipped, seen = [], [], set()
    for directory in sys.argv[1:]:
        root = Path(directory)
        release = root.parent.name
        for path in sorted(root.glob('general*.bat')):
            text = path.read_text(encoding='utf-8-sig')
            quic_line = next((line for line in text.splitlines() if line.startswith('--filter-udp=443 ')), '')
            quic_repeat = option(quic_line, 'dpi-desync-repeats', '6')
            for line in text.splitlines():
                if '--filter-tcp=' not in line or not line.startswith('--') or '%GameFilter' in line:
                    continue
                ports = option(line, 'filter-tcp', '').split(',')
                if '443' not in ports:
                    continue
                scope = 'Google TLS' if 'list-google.txt' in line else 'Общий TLS'
                name = f'Flowseal {release} · {path.stem} · {scope}'
                try:
                    tcp = convert(line, root)
                    quic_blob = (blobs(quic_line, 'dpi-desync-fake-quic', root) or ['quic_initial'])[0]
                    args = tcp + f'--new\n--filter-udp=443\n--payload=quic_initial\n--lua-desync=fake:blob={quic_blob}:repeats={quic_repeat}\n'
                except ValueError as error:
                    skipped.append({'name': name, 'reason': str(error)})
                    continue
                if args in seen:
                    continue
                seen.add(args)
                entries.append({'name': name, 'release': release, 'source': f'https://github.com/Flowseal/zapret-discord-youtube/blob/{release}/{path.name}', 'scope': scope, 'args': args})
    output = Path(__file__).resolve().parents[1] / 'router' / 'nfqws2-flowseal.json'
    output.write_text(json.dumps({'entries': entries, 'skipped': skipped}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    root = Path(sys.argv[1])
    voice = '0x' + (root / 'bin' / 'ACTIVE_DISCORD_UDP.bin').read_bytes().hex()
    game = '0x' + (root / 'bin' / 'ACTIVE_GAME_UDP.bin').read_bytes().hex()
    # general.bat voice and GameFilter UDP, adapted to explicit nfqws2 payloads.
    extras = f'''--new
--filter-tcp=2053,2083,2087,2096,8443
--payload=tls_client_hello
--lua-desync=multisplit:pos=1:seqovl=681:seqovl_pattern=tls_clienthello
--new
--filter-udp=19294-19344,50000-50100
--filter-l7=discord,stun
--payload=discord_ip_discovery,stun
--lua-desync=fake:blob={voice}:repeats=6:payload=discord_ip_discovery,stun
--new
--filter-udp=1024-65535
--filter-l7=unknown
--payload=unknown
--out-range=-n2
--lua-desync=fake:blob={game}:repeats=12:payload=unknown
'''
    (output.parent / 'nfqws2-games.args').write_text(extras, encoding='utf-8')
    print(json.dumps({'converted': len(entries), 'skipped': len(skipped), 'output': str(output)}))


if __name__ == '__main__':
    main()
