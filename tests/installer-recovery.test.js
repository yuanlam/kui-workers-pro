import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const kuiScriptPath = path.join(rootDir, 'static/vps/kui.sh');
const proxyScriptPath = path.join(rootDir, 'static/vps/residential-proxy.sh');
const kuiScript = fs.readFileSync(kuiScriptPath, 'utf8');
const proxyScript = fs.readFileSync(proxyScriptPath, 'utf8');

function runProxyHelper(command, env = {}) {
    return spawnSync('bash', ['-c', `KUI_PROXY_INSTALLER_LIB_ONLY=1 source "${proxyScriptPath}"; ${command}`], {
        encoding: 'utf8',
        env: { ...process.env, ...env },
    });
}

test('kui.sh and residential-proxy.sh pass shell syntax checks', () => {
    execFileSync('sh', ['-n', kuiScriptPath], { stdio: 'pipe' });
    execFileSync('bash', ['-n', proxyScriptPath], { stdio: 'pipe' });
});

test('kui.sh installs residential proxy before starting kui-agent in both systemd and OpenRC branches', () => {
    const step6 = kuiScript.indexOf('[6/7]');
    const step7 = kuiScript.indexOf('[7/7]');
    assert.ok(step6 >= 0 && step7 > step6);

    const step6Body = kuiScript.slice(step6, step7);
    assert.doesNotMatch(step6Body, /systemctl\s+(start|restart)\s+kui-agent/);
    assert.doesNotMatch(step6Body, /rc-service\s+kui-agent\s+(start|restart)/);

    const proxyExecIndex = kuiScript.indexOf('bash "$PROXY_INSTALLER_TEMP"');
    const systemdStartIndex = kuiScript.indexOf('systemctl start kui-agent', proxyExecIndex);
    const openrcStartIndex = kuiScript.indexOf('rc-service kui-agent start', proxyExecIndex);
    assert.ok(proxyExecIndex > step7);
    assert.ok(systemdStartIndex > proxyExecIndex, 'systemd start of kui-agent must happen after residential-proxy.sh');
    assert.ok(openrcStartIndex > proxyExecIndex, 'OpenRC start of kui-agent must happen after residential-proxy.sh');
});

test('kui.sh uses single-run signal traps and restores only originally active services on rollback', () => {
    assert.match(kuiScript, /trap 'exit 130' INT/);
    assert.match(kuiScript, /trap 'exit 143' TERM/);
    assert.match(kuiScript, /trap rollback_install EXIT/);
    assert.match(kuiScript, /ROLLBACK_DONE=0/);
    assert.match(kuiScript, /etc\/systemd\/system\/kui-agent\.service\.d\/proxy-lite\.conf/);
    assert.match(kuiScript, /ORIG_AGENT_ACTIVE=/);
    assert.match(kuiScript, /ORIG_SINGBOX_ACTIVE=/);
    assert.match(kuiScript, /ORIG_PROXY_ACTIVE=/);
    assert.match(kuiScript, /ORIG_MTPROXY_ACTIVE=/);
    assert.match(kuiScript, /ORIG_MTPROXY_ENABLED=/);
    assert.match(kuiScript, /for svc_name in \$ORIG_MTPROXY_ACTIVE/);
    assert.match(kuiScript, /trap forward_stop TERM INT/);
    assert.match(kuiScript, /stop_stale_agent_processes/);
    assert.doesNotMatch(kuiScript, /systemctl start kui-agent sing-box proxy-lite/);
});

test('residential-proxy.sh stages downloads before modifying services and preserves vendor systemd unit', () => {
    assert.doesNotMatch(proxyScript, /rm -f \/lib\/systemd\/system\/proxy-lite\.service/);
    assert.doesNotMatch(proxyScript, /rm -f [^\n]*proxy_server\.py/);
    assert.doesNotMatch(proxyScript, /rm -f [^\n]*lite_manager\.py/);
    assert.match(proxyScript, /\.staged/);
    assert.match(proxyScript, /etc\/sing-box\/config\.json/);
    assert.match(proxyScript, /etc\/systemd\/system\/kui-agent\.service\.d\/proxy-lite\.conf/);
    assert.match(proxyScript, /pidfile="\/run\/proxy-lite\.pid"/);
    assert.match(proxyScript, /trap forward_stop TERM INT/);
    assert.match(proxyScript, /stop_stale_proxy_processes/);
    assert.match(proxyScript, /trap 'exit 130' INT/);
    assert.match(proxyScript, /trap 'exit 143' TERM/);
    assert.match(proxyScript, /trap rollback_proxy_install EXIT/);

    const mainBody = proxyScript.slice(proxyScript.indexOf('main() {'));
    const downloadIdx = mainBody.indexOf('download_agents');
    const stopAgentEndIdx = mainBody.indexOf('fi\n    stop_stale_agent_processes');
    const migrateIdx = mainBody.indexOf('migrate_singbox_residential_inbound');
    const installSvcIdx = mainBody.indexOf('install_service');
    const verifyIdx = mainBody.indexOf('wait_for_proxy_listener');
    assert.ok(downloadIdx >= 0 && migrateIdx > downloadIdx, 'downloads must complete before touching sing-box or stopping services');
    assert.ok(stopAgentEndIdx > downloadIdx && migrateIdx > stopAgentEndIdx, 'stop_stale_agent_processes must run unconditionally before sing-box migration');
    assert.ok(installSvcIdx > migrateIdx, 'sing-box migration must precede proxy-lite service startup');
    assert.ok(verifyIdx > installSvcIdx, 'proxy-lite listener verification must run after service startup');
    assert.doesNotMatch(mainBody, /systemctl stop sing-box/);
    assert.doesNotMatch(mainBody, /rc-service sing-box stop/);
});

test('migrate_singbox_residential_inbound removes only residential-socks5 after sing-box check', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kui-migrate-'));
    try {
        const configPath = path.join(tmpDir, 'config.json');
        const binDir = path.join(tmpDir, 'bin');
        const checkLog = path.join(tmpDir, 'check.log');
        fs.mkdirSync(binDir);
        const fakeSingbox = path.join(binDir, 'sing-box');
        fs.writeFileSync(fakeSingbox, `#!/bin/sh\necho "$@" >> "${checkLog}"\nexit 0\n`, { mode: 0o755 });

        fs.writeFileSync(configPath, JSON.stringify({
            inbounds: [
                { type: 'socks', tag: 'residential-socks5', listen: '0.0.0.0', listen_port: 7920 },
                { type: 'shadowsocks', tag: 'in-1', listen: '::', listen_port: 8443 },
            ],
            outbounds: [{ type: 'socks', tag: 'socks5-outbound', server: '127.0.0.1', server_port: 7920 }],
        }, null, 2), { mode: 0o600 });

        const res = runProxyHelper('migrate_singbox_residential_inbound && echo "MIGRATED=$SINGBOX_MIGRATED"', {
            KUI_SINGBOX_CONF_PATH: configPath,
            PATH: `${binDir}:${process.env.PATH}`,
        });
        assert.equal(res.status, 0, res.stderr || res.stdout);
        assert.match(res.stdout, /MIGRATED=1/);

        const updated = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        assert.deepEqual(updated.inbounds, [{ type: 'shadowsocks', tag: 'in-1', listen: '::', listen_port: 8443 }]);
        assert.equal(updated.outbounds.length, 1);
        assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
        assert.match(fs.readFileSync(checkLog, 'utf8'), /check -c /);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('migrate_singbox_residential_inbound skips untouched configs and aborts when sing-box check fails', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kui-migrate-edge-'));
    try {
        const cleanConfig = path.join(tmpDir, 'clean.json');
        const originalText = JSON.stringify({ inbounds: [{ type: 'shadowsocks', tag: 'in-1' }] });
        fs.writeFileSync(cleanConfig, originalText, { mode: 0o600 });
        const beforeIno = fs.statSync(cleanConfig).ino;

        const cleanRes = runProxyHelper('migrate_singbox_residential_inbound && echo "MIGRATED=$SINGBOX_MIGRATED"', {
            KUI_SINGBOX_CONF_PATH: cleanConfig,
        });
        assert.equal(cleanRes.status, 0, cleanRes.stderr || cleanRes.stdout);
        assert.match(cleanRes.stdout, /MIGRATED=0/);
        assert.equal(fs.statSync(cleanConfig).ino, beforeIno);
        assert.equal(fs.readFileSync(cleanConfig, 'utf8'), originalText);

        const badConfig = path.join(tmpDir, 'bad.json');
        const badText = JSON.stringify({ inbounds: [{ type: 'socks', tag: 'residential-socks5' }] });
        fs.writeFileSync(badConfig, badText, { mode: 0o600 });
        const binDir = path.join(tmpDir, 'bin');
        fs.mkdirSync(binDir);
        fs.writeFileSync(path.join(binDir, 'sing-box'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });

        const failRes = runProxyHelper('migrate_singbox_residential_inbound', {
            KUI_SINGBOX_CONF_PATH: badConfig,
            PATH: `${binDir}:${process.env.PATH}`,
        });
        assert.notEqual(failRes.status, 0);
        assert.equal(fs.readFileSync(badConfig, 'utf8'), badText);
        assert.deepEqual(fs.readdirSync(tmpDir).filter((name) => name.includes('.migrate')), []);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('proxy_listener_ready verifies lite_manager.py IPv4 TCP LISTEN ownership, state file, and service PID', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kui-proc-'));
    try {
        const makeProc = (base, pid, cmdline, fdInode, proto, state, portHex, options = {}) => {
            const pidDir = path.join(base, String(pid));
            fs.mkdirSync(path.join(pidDir, 'fd'), { recursive: true });
            fs.mkdirSync(path.join(pidDir, 'net'), { recursive: true });
            fs.writeFileSync(path.join(pidDir, 'cmdline'), cmdline);
            if (options.ppid !== undefined) {
                fs.writeFileSync(path.join(pidDir, 'status'), `Name:\tpython3\nPPid:\t${options.ppid}\n`);
            }
            if (fdInode) {
                fs.symlinkSync(`socket:[${fdInode}]`, path.join(pidDir, 'fd', '5'));
            }
            const header = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
            const localHex = options.localHex || '0100007F';
            const line = fdInode
                ? `   0: ${localHex}:${portHex} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000     0        0 ${fdInode} 1 0\n`
                : '';
            fs.writeFileSync(path.join(pidDir, 'net', proto), header + line);
        };

        const missingState = path.join(tmpDir, 'missing-state.json');
        const procSingboxOnly = path.join(tmpDir, 'singbox-only');
        makeProc(procSingboxOnly, 1001, '/usr/bin/sing-box\0run\0', '90001', 'tcp', '0A', '1EF0');
        makeProc(procSingboxOnly, 1002, '/usr/bin/python3\0-u\0/opt/proxy_lite/lite_manager.py\0', '', 'tcp', '01', '1EF0');
        assert.notEqual(runProxyHelper('proxy_listener_ready', {
            KUI_PROC_DIR: procSingboxOnly,
            KUI_PROXY_LISTENER_STATE: missingState,
        }).status, 0);

        const procCustomPort = path.join(tmpDir, 'custom-port');
        makeProc(procCustomPort, 2001, '/bin/sh\0/opt/proxy_lite/run-proxy.sh\0', '', 'tcp', '01', '0000', { ppid: 1 });
        makeProc(procCustomPort, 2002, '/usr/bin/python3\0-u\0/opt/proxy_lite/lite_manager.py\0', '90002', 'tcp', '0A', '2A38', { ppid: 2001 });
        const readyState = path.join(tmpDir, 'ready-state.json');
        fs.writeFileSync(readyState, JSON.stringify({
            pid: 2002,
            host: '127.0.0.1',
            port: 10808,
            public_listener: false,
            ipv4_bound: true,
            ipv6_bound: false,
        }));
        assert.equal(runProxyHelper('proxy_listener_ready', {
            KUI_PROC_DIR: procCustomPort,
            KUI_PROXY_LISTENER_STATE: readyState,
            KUI_PROXY_SERVICE_PID: '2001',
        }).status, 0);
        assert.equal(runProxyHelper('proxy_listener_ready', {
            KUI_PROC_DIR: procCustomPort,
            KUI_PROXY_LISTENER_STATE: readyState,
            KUI_PROXY_HOST: 'localhost',
            KUI_PROXY_SERVICE_PID: '2001',
        }).status, 0);
        assert.notEqual(runProxyHelper('proxy_listener_ready', {
            KUI_PROC_DIR: procCustomPort,
            KUI_PROXY_LISTENER_STATE: readyState,
            KUI_PROXY_SERVICE_PID: '9999',
        }).status, 0);

        const ipv4PendingState = path.join(tmpDir, 'ipv4-pending-state.json');
        fs.writeFileSync(ipv4PendingState, JSON.stringify({
            pid: 2002,
            host: '0.0.0.0',
            port: 10808,
            public_listener: true,
            ipv4_bound: false,
            ipv6_bound: true,
        }));
        assert.notEqual(runProxyHelper('proxy_listener_ready', {
            KUI_PROC_DIR: procCustomPort,
            KUI_PROXY_LISTENER_STATE: ipv4PendingState,
        }).status, 0);

        const procIpv6Only = path.join(tmpDir, 'ipv6-only');
        makeProc(procIpv6Only, 3003, '/usr/bin/python3\0-u\0/opt/proxy_lite/lite_manager.py\0', '90003', 'tcp6', '0A', '1EF0');
        assert.notEqual(runProxyHelper('proxy_listener_ready', {
            KUI_PROC_DIR: procIpv6Only,
            KUI_PROXY_LISTENER_STATE: missingState,
        }).status, 0);

        const missingPidfile = path.join(tmpDir, 'missing-proxy-lite.pid');
        assert.notEqual(runProxyHelper('INIT_SYS=openrc; proxy_listener_ready', {
            KUI_PROC_DIR: procCustomPort,
            KUI_PROXY_LISTENER_STATE: missingState,
            KUI_PROXY_PIDFILE: missingPidfile,
        }).status, 0);

        const validPidfile = path.join(tmpDir, 'proxy-lite.pid');
        fs.writeFileSync(validPidfile, '2001\n');
        assert.equal(runProxyHelper('INIT_SYS=openrc; proxy_listener_ready', {
            KUI_PROC_DIR: procCustomPort,
            KUI_PROXY_LISTENER_STATE: readyState,
            KUI_PROXY_PIDFILE: validPidfile,
        }).status, 0);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('installer lock serializes concurrent stale-lock recovery and parse_args enforces HTTPS REALTIME_URL', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kui-lock-'));
    try {
        const lockDir = path.join(tmpDir, 'installer.lock.d');
        fs.mkdirSync(lockDir);
        fs.writeFileSync(path.join(lockDir, 'pid'), `${process.pid}\n`);
        const blocked = runProxyHelper('acquire_installer_lock', { KUI_INSTALLER_LOCK_DIR: lockDir });
        assert.notEqual(blocked.status, 0);
        assert.ok(fs.existsSync(lockDir));

        fs.writeFileSync(path.join(lockDir, 'pid'), '999999\n');
        const { spawn } = await import('node:child_process');
        const runContender = () => new Promise((resolve) => {
            const child = spawn('bash', [
                '-c',
                `KUI_PROXY_INSTALLER_LIB_ONLY=1 source "${proxyScriptPath}"; acquire_installer_lock; sleep 0.4; release_installer_lock`,
            ], {
                env: { ...process.env, KUI_INSTALLER_LOCK_DIR: lockDir },
                stdio: 'pipe',
            });
            child.on('close', (code) => resolve(code));
        });
        const codes = await Promise.all([runContender(), runContender(), runContender()]);
        assert.equal(codes.filter((code) => code === 0).length, 1, `expected exactly one winner, got ${JSON.stringify(codes)}`);
        assert.equal(fs.existsSync(lockDir), false);

        const oldTime = new Date(Date.now() - 180 * 1000);
        fs.mkdirSync(lockDir);
        fs.utimesSync(lockDir, oldTime, oldTime);
        const reclaimDir = `${lockDir}.reclaim`;
        fs.mkdirSync(reclaimDir);
        fs.utimesSync(reclaimDir, oldTime, oldTime);
        const concurrentEmptyHealed = await Promise.all([
            runContender(),
            runContender(),
            runContender(),
            runContender(),
            runContender(),
        ]);
        assert.equal(
            concurrentEmptyHealed.filter((code) => code === 0).length,
            1,
            `expected exactly one winner with stale empty lock + stale reclaim, got ${JSON.stringify(concurrentEmptyHealed)}`,
        );
        assert.equal(fs.existsSync(lockDir), false);
        assert.equal(fs.existsSync(reclaimDir), false);

        fs.mkdirSync(lockDir);
        fs.writeFileSync(path.join(lockDir, 'pid'), '999999\n');
        fs.mkdirSync(reclaimDir);
        fs.utimesSync(reclaimDir, oldTime, oldTime);
        const concurrentDeadHealed = await Promise.all([
            runContender(),
            runContender(),
            runContender(),
            runContender(),
            runContender(),
        ]);
        assert.equal(
            concurrentDeadHealed.filter((code) => code === 0).length,
            1,
            `expected exactly one winner with dead-pid lock + stale reclaim, got ${JSON.stringify(concurrentDeadHealed)}`,
        );
        assert.equal(fs.existsSync(lockDir), false);
        assert.equal(fs.existsSync(reclaimDir), false);

        const fakeBinFailMv = path.join(tmpDir, 'fake-bin-fail-mv');
        fs.mkdirSync(fakeBinFailMv);
        fs.writeFileSync(path.join(fakeBinFailMv, 'flock'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        fs.writeFileSync(path.join(fakeBinFailMv, 'mv'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
        const pidPublishFailed = runProxyHelper('acquire_installer_lock', {
            KUI_INSTALLER_LOCK_DIR: lockDir,
            PATH: `${fakeBinFailMv}:${process.env.PATH}`,
        });
        assert.notEqual(pidPublishFailed.status, 0);
        assert.equal(fs.existsSync(lockDir), false, 'failed PID publish must clean up partial lock directory');

        const noLockToolsBin = path.join(tmpDir, 'no-lock-tools');
        fs.mkdirSync(noLockToolsBin);
        for (const cmd of ['bash', 'dirname', 'rm', 'mkdir', 'cat', 'mv', 'find', 'sleep']) {
            const resolved = spawnSync('which', [cmd], { encoding: 'utf8' }).stdout.trim();
            if (resolved) {
                fs.symlinkSync(resolved, path.join(noLockToolsBin, cmd));
            }
        }
        const missingTools = runProxyHelper('acquire_installer_lock', {
            KUI_INSTALLER_LOCK_DIR: lockDir,
            PATH: noLockToolsBin,
        });
        assert.notEqual(missingTools.status, 0);
        assert.match(missingTools.stdout + missingTools.stderr, /flock.*python3/);
        assert.equal(fs.existsSync(lockDir), false);

        const badRealtime = runProxyHelper(
            'parse_args --domain https://example.com --token tok_1 --ip 1.2.3.4',
            { REALTIME_URL: 'wss://rt.example.com/ws?role=proxy' },
        );
        assert.notEqual(badRealtime.status, 0);
        assert.match(badRealtime.stdout + badRealtime.stderr, /REALTIME_URL/);

        const multilineRealtime = runProxyHelper(
            'parse_args --domain https://example.com --token tok_1 --ip 1.2.3.4',
            { REALTIME_URL: 'https://rt.example.com\nEVIL=1' },
        );
        assert.notEqual(multilineRealtime.status, 0);
        assert.match(multilineRealtime.stdout + multilineRealtime.stderr, /REALTIME_URL/);

        const injectedRealtime = runProxyHelper(
            'parse_args --domain https://example.com --token tok_1 --ip 1.2.3.4',
            { REALTIME_URL: 'https://bad.example.com/$(id)' },
        );
        assert.notEqual(injectedRealtime.status, 0);
        assert.match(injectedRealtime.stdout + injectedRealtime.stderr, /REALTIME_URL/);

        const multilineDomain = runProxyHelper(
            'parse_args --domain "$BAD_DOMAIN" --token tok_1 --ip 1.2.3.4',
            { BAD_DOMAIN: 'https://example.com\nEVIL=1' },
        );
        assert.notEqual(multilineDomain.status, 0);

        const goodRealtime = runProxyHelper(
            'detect_pkg_manager() { echo apt; }; detect_init_system() { echo systemd; }; parse_args --domain https://example.com --token tok_1 --ip 1.2.3.4',
            { REALTIME_URL: 'https://rt.example.com' },
        );
        assert.equal(goodRealtime.status, 0, goodRealtime.stderr || goodRealtime.stdout);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});
