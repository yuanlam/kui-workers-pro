/* ================= Proxy Controller 双活引擎总控 (内联逻辑) ================= */
        let pcInterval = null;
        let pcCurrentScoreIp = "";

        function pcEscapeHtml(value) {
            return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
        }

        async function getPcAuthHeader(method, path) {
            const user = sessionStorage.getItem('kui_user') || 'admin';
            const key = sessionStorage.getItem('kui_auth_key') || '';
            if (!key) return '';
            return `Bearer ${key}`;
        }

        function pcPopulateTargets() {
            const select = document.getElementById('slot-target-ip');
            if (!select) return [];
            const managedServers = window.kuiManagedServers?.() || (window.kuiManagedServerIps?.() || []).map(ip => ({ name: '', ip }));
            const targets = managedServers.map(server => server.ip);
            const previous = select.value;
            select.innerHTML = targets.length
                ? managedServers.map(server => `<option value="${pcEscapeHtml(server.ip)}">${pcEscapeHtml(server.name || server.ip)} : ${pcEscapeHtml(server.ip)}</option>`).join('') + (targets.length > 1 ? '<option value="*">全部 VPS</option>' : '')
                : '<option value="">暂无 VPS</option>';
            select.value = (previous === '*' || targets.includes(previous)) ? previous : (targets[0] || '');
            return targets;
        }

        function pcSelectedTargets() {
            const targets = pcPopulateTargets();
            const selected = document.getElementById('slot-target-ip')?.value || '';
            return selected === '*' ? targets : (selected ? [selected] : []);
        }

        async function pcFetchCountries(throwOnError = false) {
            try {
                const auth = await getPcAuthHeader('GET', '/api/proxy/countries');
                const res = await fetch('/api/proxy/countries', { headers: { 'Authorization': auth } });
                const list = await res.json();
                const container = document.getElementById('countries-list');
                if (!container) return;
                const entries = Array.isArray(list) ? list.map(item => {
                    if (typeof item === 'string') return { code: item.toUpperCase(), nodes: null };
                    return { code: String(item?.code || item?.country || '').toUpperCase(), nodes: Number.isFinite(Number(item?.nodes)) ? Number(item.nodes) : null };
                }).filter(item => /^[A-Z]{2}$/.test(item.code)).sort((a, b) => {
                    const nodeDelta = (b.nodes ?? -1) - (a.nodes ?? -1);
                    return nodeDelta || a.code.localeCompare(b.code, 'en');
                }) : [];
                container.innerHTML = entries.map(item => {
                    const code = pcEscapeHtml(item.code);
                    const count = item.nodes === null ? '—' : item.nodes;
                    const countClass = item.nodes === null ? 'text-slate-500' : (item.nodes > 0 ? 'text-emerald-400' : 'text-rose-400');
                    return `<button type="button" data-country-code="${code}" title="选择 ${code}，候选节点 ${count} 个" class="pc-country-chip">${code}<span class="ml-1 ${countClass}">${count}</span></button>`;
                }).join('');
                container.onclick = event => {
                    const button = event.target.closest('[data-country-code]');
                    const input = document.getElementById('slot-cfg-0');
                    if (button && input) { input.value = button.dataset.countryCode; input.focus(); }
                };
            } catch(e) {
                console.warn('[pc] countries failed:', e);
                if (throwOnError) throw e;
            }
        }

        export async function pcLoadConfig(throwOnError = false) {
            try {
                const targets = pcPopulateTargets();
                const selected = document.getElementById('slot-target-ip')?.value || '';
                const targetIp = selected === '*' ? targets[0] : selected;
                if (!targetIp) throw new Error('暂无已接入 VPS');
                const auth = await getPcAuthHeader('GET', '/api/proxy/config');
                const res = await fetch(`/api/proxy/config?ip=${encodeURIComponent(targetIp)}`, { headers: { 'Authorization': auth } });
                if (!res.ok) { const err = await res.text(); throw new Error(err || res.status); }
                const map = await res.json();
                const cfg0 = document.getElementById('slot-cfg-0');
                const port = document.getElementById('slot-port');
                const listenHost = document.getElementById('slot-listen-host');
                const country = map["0"] || map.proxy?.country || 'JP';
                if (cfg0) cfg0.value = String(country).toUpperCase();
                if (port) port.value = map["port"] || map.proxy?.port || 7920;
                if (listenHost) listenHost.value = map.proxy?.listen_host || map.listen_host || '';
            } catch(e) {
                console.warn('[pc] loadConfig failed:', e);
                if (throwOnError) throw e;
            }
        }

        export async function pcSaveConfig() {
            const val = document.getElementById(`slot-cfg-0`).value.toUpperCase().trim() || 'JP';
            const port = parseInt(document.getElementById(`slot-port`).value) || 7920;
            const listenHost = document.getElementById('slot-listen-host')?.value.trim() || '';
            if (listenHost && !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(listenHost)) { alert('❌ Docker 网桥地址必须是 IPv4 地址，例如 172.17.0.1'); return; }
            try {
                const targets = pcSelectedTargets();
                if (!targets.length) throw new Error('暂无已接入 VPS');
                const results = await Promise.allSettled(targets.map(async ip => {
                    const auth = await getPcAuthHeader('POST', '/api/proxy/config');
                    const res = await fetch('/api/proxy/config', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': auth }, body: JSON.stringify({ ip, "0": val, "country": val, "port": port, "listen_host": listenHost }) });
                    const text = await res.text();
                    if (!res.ok) throw new Error(text || res.status);
                    window.kuiNotifyRealtime?.(ip);
                    return { ip, text };
                }));
                const succeeded = results.filter(result => result.status === 'fulfilled').map(result => result.value);
                const failed = results.map((result, index) => ({ result, ip: targets[index] })).filter(item => item.result.status === 'rejected');
                if (!succeeded.length) throw new Error(failed.map(item => `${item.ip}: ${item.result.reason?.message || item.result.reason}`).join('\n'));
                // 直接从 POST 响应体更新输入字段，避免立即回读时 D1 最终一致性导致读到旧数据
                try {
                    const resp = JSON.parse(succeeded[succeeded.length - 1].text);
                    const saved = resp.slot_map || resp.proxy || {};
                    const cfg0 = document.getElementById('slot-cfg-0');
                    const portEl = document.getElementById('slot-port');
                    if (cfg0) cfg0.value = String(saved["0"] || saved.country || val).toUpperCase();
                    if (portEl) portEl.value = saved.port || port;
                } catch(e) { console.warn('[pc] parse response failed', e); }
                if (failed.length) alert(`⚠️ 下发完成：成功 ${succeeded.length} 台，失败 ${failed.length} 台\n${failed.map(item => `${item.ip}: ${item.result.reason?.message || item.result.reason}`).join('\n')}`);
                else alert(`🚀 策略及端口已实时下发到 ${succeeded.length} 台 VPS！`);
            } catch (e) { alert('❌ 下发失败: ' + e.message); }
        }

        export async function pcSwitchIP() {
            const val = document.getElementById(`slot-cfg-0`).value.toUpperCase().trim() || 'JP';
            const port = parseInt(document.getElementById(`slot-port`).value) || 7920;
            try {
                const targets = pcSelectedTargets();
                if (!targets.length) throw new Error('暂无已接入 VPS');
                const trigger = Date.now();
                const results = await Promise.allSettled(targets.map(async ip => {
                    const auth = await getPcAuthHeader('POST', '/api/proxy/config');
                    const res = await fetch('/api/proxy/config', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': auth }, body: JSON.stringify({ ip, "0": val, "country": val, "port": port, "switch_trigger": trigger }) });
                    if (!res.ok) { const err = await res.text(); throw new Error(err || res.status); }
                    window.kuiNotifyRealtime?.(ip);
                    return ip;
                }));
                const succeeded = results.filter(result => result.status === 'fulfilled');
                const failed = results.map((result, index) => ({ result, ip: targets[index] })).filter(item => item.result.status === 'rejected');
                if (!succeeded.length) throw new Error(failed.map(item => `${item.ip}: ${item.result.reason?.message || item.result.reason}`).join('\n'));
                if (failed.length) alert(`⚠️ 重拨完成：成功 ${succeeded.length} 台，失败 ${failed.length} 台\n${failed.map(item => `${item.ip}: ${item.result.reason?.message || item.result.reason}`).join('\n')}`);
                else alert(`🔄 重拨指令已实时下发到 ${succeeded.length} 台 VPS！`);
            } catch (e) { alert('❌ 下发失败: ' + e.message); }
        }

        async function pcLoadNativeIpScore(ip) {
            const container = document.getElementById('pc-native-score-container');
            if (!container) return;
            container.innerHTML = '<div class="col-span-full py-16 flex flex-col items-center justify-center text-slate-500"><svg class="animate-spin h-8 w-8 text-indigo-500 mb-4" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" fill="none"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg><span>穿透请求中，正在构建原生质检报告...</span></div>';

            try {
                const authHeaders = window.kuiAdminAuthHeader ? await window.kuiAdminAuthHeader() : {};
                const res = await fetch('/api/proxy/testisp-lookup/' + ip, { headers: authHeaders });
                const rawText = await res.text();

                let d;
                try {
                    d = JSON.parse(rawText);
                } catch (e) {
                    const safeText = rawText.substring(0, 500).replace(/</g, '&lt;').replace(/>/g, '&gt;');
                    throw new Error(`目标接口返回了非 JSON 格式数据(可能 API 路径错误或被云端盾拦截)。<br>HTTP 状态码: ${res.status}<br><div class="mt-3 text-left bg-slate-900 p-3 rounded text-xs text-rose-300 font-mono break-all overflow-y-auto max-h-32 border border-rose-500/30">${safeText}</div>`);
                }

                if (!d || !d.geo || !d.isp) {
                    container.innerHTML = `<div class="col-span-full text-center py-8 text-rose-400 bg-rose-500/10 rounded-xl border border-rose-500/20">无法获取报告: 接口返回数据结构异常 ${pcEscapeHtml(d && d.error || '')}</div>`;
                    return;
                }

                const isHosting = d.isp.flag === 'hosting';
                const threat = !!(d.risk?.threat_listed ?? d.isp?.risk?.threat_listed);
                const isNative = d.geo.is_native;

                const tags = isHosting
                    ? '<span class="px-2 py-0.5 rounded-full bg-rose-500/20 text-rose-400 border border-rose-500/20 text-xs font-bold">机房IP</span>'
                    : '<span class="px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/20 text-xs font-bold">家庭宽带</span>';

                const locStr = pcEscapeHtml([d.geo.country, d.geo.city].filter(Boolean).join(" "));
                const orgStr = pcEscapeHtml(d.isp.org || '-');
                const safeIp = pcEscapeHtml(ip);
                const countryCode = pcEscapeHtml(d.geo.country_code || 'N/A');
                const nativeType = pcEscapeHtml(d.geo.native_type || '广播 IP');
                const ispType = pcEscapeHtml(d.isp.type || '-');
                const asn = pcEscapeHtml(d.isp.asn || '-');
                const timezone = pcEscapeHtml(d.geo.timezone || '-');
                const driftKm = pcEscapeHtml(d.geo.drift_km || 0);
                const rdns = pcEscapeHtml(d.isp.rdns || '-');
                const warning = pcEscapeHtml(d.isp.warning || '未检测到明显异常');
                const dataSource = pcEscapeHtml(d.data_source || 'Unknown');

                container.innerHTML = `
                    <div class="pc-score-summary col-span-full bg-slate-800/60 border border-slate-700/80 p-4 rounded-xl flex flex-wrap gap-3 justify-between items-center shadow-lg">
                        <div class="flex items-center gap-4">
                            <span class="pc-score-ip text-2xl font-extrabold font-mono tracking-tight">${safeIp}</span>
                            <span class="text-slate-400 text-sm hidden sm:flex items-center border-l border-slate-700 pl-4 h-6">
                                <span class="uppercase tracking-widest text-indigo-400 mr-2 text-xs font-bold">${countryCode}</span>
                                ${locStr} · ${orgStr}
                            </span>
                        </div>
                    </div>

                    <div class="pc-score-card bg-slate-800/40 border border-slate-700/60 p-5 rounded-xl flex flex-col gap-3 shadow-sm hover:shadow-md transition-shadow hover:bg-slate-800/60">
                        <h4 class="text-xs font-bold text-slate-500 uppercase tracking-widest pb-3 border-b border-slate-700/50">基础物理画像</h4>
                        <div class="flex justify-between items-center"><span class="text-slate-400 text-sm">IP 原生性</span> <span class="font-medium text-sm">${isNative ? '<span class="px-2.5 py-1 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 text-xs font-bold">原生 IP (Native)</span>' : `<span class="px-2.5 py-1 rounded-full bg-amber-500/20 text-amber-400 border border-amber-500/30 text-xs font-bold">${nativeType}</span>`}</span></div>
                        <div class="flex justify-between items-center"><span class="text-slate-400 text-sm">业务标记</span> <div class="flex gap-1">${tags}</div></div>
                        <div class="flex justify-between items-center"><span class="text-slate-400 text-sm">运营类型</span> <span class="font-medium ${isHosting ? 'text-rose-400' : 'text-emerald-400'} text-sm">${ispType}</span></div>
                        <div class="pc-score-field flex justify-between items-start gap-3"><span class="text-slate-400 text-sm">归属机构</span> <span class="pc-score-value font-medium text-slate-300 text-sm" title="${orgStr}">${orgStr}</span></div>
                    </div>

                    <div class="pc-score-card bg-slate-800/40 border border-slate-700/60 p-5 rounded-xl flex flex-col gap-3 shadow-sm hover:shadow-md transition-shadow hover:bg-slate-800/60">
                        <h4 class="text-xs font-bold text-slate-500 uppercase tracking-widest pb-3 border-b border-slate-700/50">ISP 网络底层</h4>
                        <div class="flex justify-between items-center"><span class="text-slate-400 text-sm">ASN</span> <span class="font-medium text-indigo-300 text-sm font-mono">${asn}</span></div>
                        <div class="flex justify-between items-center"><span class="text-slate-400 text-sm">解析时区</span> <span class="font-medium text-slate-300 text-sm font-mono">${timezone}</span></div>
                        <div class="flex justify-between items-center"><span class="text-slate-400 text-sm">偏移量 (Drift)</span> <span class="font-medium ${d.geo.has_drift ? 'text-rose-400' : 'text-emerald-400'} text-sm">${driftKm} km</span></div>
                        <div class="flex justify-between items-center"><span class="text-slate-400 text-sm">反向 DNS (rDNS)</span> <span class="font-medium text-slate-400 text-xs font-mono truncate max-w-[150px]" title="${rdns}">${rdns}</span></div>
                    </div>

                    <div class="pc-score-card bg-slate-800/40 border border-slate-700/60 p-5 rounded-xl flex flex-col gap-3 shadow-sm hover:shadow-md transition-shadow hover:bg-slate-800/60">
                        <h4 class="text-xs font-bold text-slate-500 uppercase tracking-widest pb-3 border-b border-slate-700/50">风险深度检测</h4>
                        <div class="flex justify-between items-center"><span class="text-slate-400 text-sm">Spamhaus 情报</span> <span class="${threat ? 'px-2.5 py-1 rounded-full bg-rose-500/20 text-rose-400 border border-rose-500/30 text-xs font-bold' : 'px-2.5 py-1 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 text-xs font-bold'}">${threat ? '🚨 已在黑名单' : '✅ 纯净无异常'}</span></div>
                        <div class="pc-score-field flex justify-between items-start gap-3"><span class="text-slate-400 text-sm">代理/机房特征</span> <span class="pc-score-value font-medium text-xs font-bold ${d.isp.warning ? 'text-amber-400' : 'text-emerald-400'}" title="${warning}">${warning}</span></div>
                        <div class="flex justify-between items-center"><span class="text-slate-400 text-sm">数据源</span> <span class="font-medium text-slate-400 text-xs">${dataSource}</span></div>
                    </div>
                `;
            } catch (e) {
                const errorMessage = document.createElement('div');
                errorMessage.className = 'col-span-full text-left whitespace-pre-wrap p-6 text-rose-400 bg-rose-500/10 rounded-xl border border-rose-500/20';
                errorMessage.textContent = String(e.message || '质检请求失败');
                container.replaceChildren(errorMessage);
            }
        }

        let lastPcHttpFetch = 0;
        let pcHttpServers = [];
        export async function pcFetchNodes(throwOnError = false) {
            try {
                let servers = [];
                const realtimeSnapshots = Object.values(window.kuiRealtimeProxySnapshots || {});
                // Realtime is a fast path only. Keep an HTTP snapshot so a missing proxy
                // socket or an incomplete realtime patch cannot hide persisted tunnel data.
                if (Date.now() - lastPcHttpFetch >= 15000) {
                    const auth = await getPcAuthHeader('GET', '/api/proxy/nodes');
                    const res = await fetch(`/api/proxy/nodes?t=${Date.now()}`, { headers: { 'Authorization': auth } });
                    if (!res.ok) throw new Error(`proxy nodes ${res.status}`);
                    pcHttpServers = await res.json(); lastPcHttpFetch = Date.now();
                }
                servers = pcHttpServers.slice();
                if (realtimeSnapshots.length) {
                    const byIp = new Map(servers.map(server => [server.ip, server]));
                    realtimeSnapshots.forEach(snapshot => {
                        const previous = byIp.get(snapshot.ip) || {};
                        const realtimeDetails = Array.isArray(snapshot.proxy?.details) && snapshot.proxy.details.length ? JSON.stringify(snapshot.proxy.details) : previous.details || '[]';
                        byIp.set(snapshot.ip, { ...previous, ip: snapshot.ip, details: realtimeDetails, last_seen: snapshot.proxy_last_seen || snapshot.updated_at || previous.last_seen, logs: snapshot.proxy?.logs || previous.logs || '' });
                    });
                    servers = Array.from(byIp.values());
                }
                const tbody = document.getElementById('pc-nodes-table');
                const terminal = document.getElementById('pc-terminal-output');
                if (!tbody) return;

                if (!servers || servers.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="6" class="py-12 text-center text-slate-500 flex-col items-center justify-center"><svg class="w-12 h-12 mx-auto text-slate-700 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"></path></svg>未检测到在线母机，请在 VPS 运行纳管命令接入</td></tr>';
                    return;
                }

                const managedServerNames = new Map((window.kuiManagedServers?.() || []).map(server => [server.ip, String(server.name || '').trim()]));
                tbody.innerHTML = servers.map(server => {
                    const details = JSON.parse(server.details || '[]');
                    const timeAgo = Math.floor((Date.now() - server.last_seen) / 1000);
                    const serverName = pcEscapeHtml(server.name || managedServerNames.get(server.ip) || '未命名主机');
                    const serverIp = pcEscapeHtml(server.ip);

                    let proxyEgress = '';
                    let proxyStatuses = '';
                    if (details.length === 0) {
                        if (timeAgo < 120) {
                            proxyEgress = `
                            <div class="inline-flex items-center bg-slate-900 border border-sky-500/30 rounded-xl px-3 py-1.5 shadow-inner text-sky-400/90 text-sm">
                                <svg class="animate-spin -ml-1 mr-2 h-4 w-4 text-sky-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                                通道握手初始化中...
                            </div>`;
                        } else if (timeAgo < 360) {
                            proxyEgress = `
                            <div class="inline-flex items-center bg-slate-900 border border-slate-700/50 rounded-xl px-3 py-1.5 shadow-inner text-slate-400/80 text-xs">
                                <svg class="animate-spin -ml-1 mr-2 h-3 w-3 text-slate-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                                隧道数据同步中...
                            </div>`;
                        } else {
                            proxyEgress = `
                            <div class="inline-flex items-center bg-slate-900 border border-amber-500/30 rounded-xl px-3 py-1.5 shadow-inner text-amber-400/90 text-sm">
                                <svg class="animate-spin -ml-1 mr-2 h-4 w-4 text-amber-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
                                双路通道失联，正在抢救拨号中...
                            </div>`;
                        }
                        proxyStatuses = '<span class="pc-matrix-status text-slate-500 text-xs">等待同步</span>';
                    } else {
                        proxyEgress = '<div class="pc-matrix-egress">' + details.map(d => `
                            <div class="pc-matrix-line pc-tunnel-row inline-flex items-center">
                                <span class="pc-tunnel-name bg-slate-800 text-slate-300 font-mono text-xs px-2 py-0.5 rounded-md border border-slate-700 font-bold">${pcEscapeHtml(d.tunnel)}</span>
                                <span class="bg-indigo-500/20 text-indigo-400 font-bold font-mono text-xs px-2 py-0.5 rounded-md border border-indigo-500/20">${pcEscapeHtml(d.country)}</span>
                                <span class="font-mono text-slate-300 text-xs tracking-wide" title="出口物理 IP">${pcEscapeHtml(d.node_ip || '---.---.---.---')}:${pcEscapeHtml(d.port)}</span>
                            </div>`).join('') + '</div>';
                        proxyStatuses = '<div class="pc-matrix-status">' + details.map(d => {
                            const isActive = d.active;
                            const statusColorClass = isActive ? 'bg-emerald-500' : 'bg-sky-500';
                            const statusText = isActive ? 'ACTIVE（业务出口）' : 'STANDBY（热备就绪）';
                            const textColorClass = isActive ? 'text-emerald-400' : 'text-sky-400';

                            return `<div class="pc-matrix-line pc-tunnel-status ${textColorClass}"><span class="pc-tunnel-status-dot ${statusColorClass} shadow-[0_0_5px_currentColor]"></span>${statusText}</div>`;
                        }).join('') + '</div>';
                    }

                    return `
                        <tr class="pc-node-row transition-colors group">
                            <td class="pc-matrix-host-name py-3 px-4 align-middle">
                                <div class="pc-host-identity flex items-center gap-2">
                                    <svg class="w-4 h-4 text-slate-600 group-hover:text-indigo-400 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01"></path></svg>
                                    <span class="pc-host-name">${serverName}</span>
                                </div>
                            </td>
                            <td class="pc-matrix-host-ip py-3 px-4 align-middle"><span class="pc-host-ip">${serverIp}</span></td>
                            <td class="py-3 px-4 align-middle">
                                <span class="flex items-center gap-1.5 ${timeAgo < 20 ? 'text-emerald-400' : 'text-rose-400'} font-mono text-xs">
                                    <span class="w-1.5 h-1.5 rounded-full ${timeAgo < 20 ? 'bg-emerald-500 animate-pulse' : 'bg-rose-500'}"></span>
                                    ${timeAgo}s 前
                                </span>
                            </td>
                            <td class="py-3 px-4 align-middle">
                                <span class="pc-channel-count ${details.length === 2 ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : (details.length === 1 ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30' : 'bg-rose-500/20 text-rose-400 border border-rose-500/30')} py-1 px-3 rounded-md text-xs font-mono font-bold">
                                    ${details.length}/2
                                </span>
                            </td>
                            <td class="py-3 px-4 align-middle">${proxyEgress}</td>
                            <td class="py-3 px-4 align-middle">${proxyStatuses}</td>
                        </tr>
                    `;
                }).join('');

                const selectedIp = document.getElementById('slot-target-ip')?.value || '';
                const selectedServer = (selectedIp && selectedIp !== '*' ? servers.find(server => server.ip === selectedIp) : null) || servers[0];
                if (selectedServer?.details) {
                    const details = JSON.parse(selectedServer.details);
                    const activeNode = details.find(d => d.active) || details[0];
                    if (activeNode && activeNode.node_ip) {
                        const newIp = activeNode.node_ip;
                        if (newIp !== pcCurrentScoreIp) {
                            pcCurrentScoreIp = newIp;
                            const scoreSection = document.getElementById('pc-ip-score-section');
                            if (scoreSection) scoreSection.style.display = 'block';

                            const scoreLink = document.getElementById('pc-ip-score-link');
                            scoreLink.href = `https://testisp.info/?ip=${newIp}`;
                            scoreLink.onclick = (e) => {
                                e.preventDefault();
                                navigator.clipboard.writeText(newIp).then(() => {
                                    alert('🟢 已自动复制隧道节点 IP: ' + newIp + '\n\n由于 testisp.info 官网默认仅检测本机，请在随后打开的网页【输入框】中【粘贴】并回车查询！');
                                    window.open(`https://testisp.info/?ip=${newIp}`, '_blank');
                                }).catch(() => {
                                    window.open(`https://testisp.info/?ip=${newIp}`, '_blank');
                                });
                            };

                            pcLoadNativeIpScore(newIp);
                        }
                    }
                }

                if (terminal && selectedServer?.logs) {
                    const isAtBottom = terminal.scrollHeight - terminal.scrollTop <= terminal.clientHeight + 30;

                    let logHTML = selectedServer.logs
                        .replace(/</g, '&lt;').replace(/>/g, '&gt;')
                        .replace(/\[\*\]/g, '<span class="text-indigo-400 font-bold">[*]</span>')
                        .replace(/\[\+\]/g, '<span class="text-emerald-400 font-bold">[+]</span>')
                        .replace(/\[\-\]/g, '<span class="text-rose-400 font-bold">[-]</span>')
                        .replace(/\[\!\]/g, '<span class="text-amber-400 font-bold">[!]</span>');

                    terminal.innerHTML = '<pre class="whitespace-pre-wrap break-all">' + logHTML + '</pre>';

                    if (isAtBottom) {
                        terminal.scrollTop = terminal.scrollHeight;
                    }
                } else if (terminal) {
                    terminal.textContent = '当前 VPS 暂无日志。';
                }

            } catch (err) {
                console.warn('[pc] nodes failed:', err);
                if (throwOnError) throw err;
            }
        }

        export function pcInitProxy() {
            pcStopProxy();
            pcCurrentScoreIp = "";

            pcPopulateTargets();
            pcFetchCountries();
            pcLoadConfig();
            pcFetchNodes();
            if (!window.kuiRealtimeConnected) pcInterval = setInterval(pcFetchNodes, 60000);
        }

        export function pcStopProxy() {
            if (pcInterval) { clearInterval(pcInterval); pcInterval = null; }
        }

        // Keep the legacy window bridge for manual refresh and custom integrations.
        Object.assign(window, { pcFetchCountries, pcFetchNodes, pcLoadConfig, pcSaveConfig, pcSwitchIP });
