import { formatExitPurityMeta } from '../utils/egressState.js';

/* ================= Proxy Controller 双活引擎总控 (内联逻辑) ================= */
        let pcInterval = null;
        let pcCurrentScoreIp = "";

        function pcEscapeHtml(value) {
            return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
        }

        function pcNormalizeCountryInput(value) {
            return String(value ?? '').replace(/\s+/g, '').toUpperCase();
        }

        export function normalizePcCountry(value) {
            const country = pcNormalizeCountryInput(value);
            return country === 'ANY' || /^[A-Z]{2}$/.test(country) ? country : '';
        }

        export function isValidPcCountry(value) {
            return !!normalizePcCountry(value);
        }

        function normalizePcSwitchMode(value) {
            return String(value ?? '').trim().toLowerCase() === 'full' ? 'full' : 'hot';
        }

        export function normalizePcListenHost(value) {
            const host = String(value ?? '').trim();
            return host === '0.0.0.0' || host === '::' ? '*' : host;
        }

        export function isValidPcListenHost(value) {
            const host = normalizePcListenHost(value);
            if (!host || host === '*') return true;
            if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)) return false;
            return host.split('.').every(octet => Number(octet) >= 0 && Number(octet) <= 255);
        }

        function pcResolveListenHost(config) {
            if (config?.proxy?.public_listener === true || config?.slot_map?.public_listener === true || config?.public_listener === true) return '*';
            for (const candidate of [config?.proxy?.listen_host, config?.slot_map?.listen_host, config?.listen_host]) {
                if (candidate === undefined || candidate === null) continue;
                const host = normalizePcListenHost(candidate);
                if (!host) continue;
                if (isValidPcListenHost(host)) return host;
            }
            return '127.0.0.1';
        }

        function pcResolveSavedListenHost(payload, proxy) {
            if (proxy?.public_listener === true || payload?.slot_map?.public_listener === true || payload?.public_listener === true) return '*';
            for (const candidate of [proxy?.listen_host, payload?.slot_map?.listen_host, payload?.listen_host]) {
                if (candidate === undefined || candidate === null) continue;
                const host = normalizePcListenHost(candidate);
                if (host) return host;
            }
            return '127.0.0.1';
        }

        function pcListenHostField() {
            return document.getElementById('slot-listen-host');
        }

        let pcFormRevision = 0;
        let pcFormUserRevision = 0;
        let pcTargetSelectionEpoch = 0;
        let pcLoadSeq = 0;
        let pcConfigEpoch = 0;
        let pcWriteEpoch = 0;
        let pcLoadedForm = null;
        let pcObservedTarget = '';
        let pcTargetObserved = false;
        let pcPendingRetry = null;
        let pcDeferredReload = null;
        let pcRefreshReload = null;
        let pcDeferredReloadReported = null;
        let pcBackgroundReloadSeq = 0;
        const pcBackgroundReloadReporters = new Map();
        let pcDeferredReloadPromise = null;
        let pcResumeTimer = null;
        const pcActiveWrites = new Map();
        const pcWriteVersions = new Map();
        const pcWriteFieldBaselines = new Map();
        let pcAppliedLoadSeq = 0;
        const pcPendingRefreshLoads = new Set();
        const pcFieldRevisions = {
            'slot-cfg-0': 0,
            'slot-port': 0,
            'slot-listen-host': 0,
        };
        const pcFieldEpochs = {
            'slot-cfg-0': 0,
            'slot-port': 0,
            'slot-listen-host': 0,
        };
        const pcCleanFieldRevisions = {
            'slot-cfg-0': 0,
            'slot-port': 0,
            'slot-listen-host': 0,
        };

        function pcBumpFormRevision() {
            pcFormRevision += 1;
        }

        function pcBumpUserEdit(source) {
            const id = typeof source === 'string'
                ? source
                : (source?.target?.id || source?.id || '');
            if (Object.hasOwn(pcFieldRevisions, id)) {
                pcFieldRevisions[id] += 1;
                pcFieldEpochs[id] = pcTargetSelectionEpoch;
            }
            pcFormUserRevision += 1;
            pcBumpFormRevision();
        }

        function pcBaselineFieldRevisions(fieldRevisions, selectionEpoch) {
            const baseline = { ...fieldRevisions };
            for (const id of Object.keys(baseline)) {
                baseline[id] = pcFieldEpochs[id] === selectionEpoch
                    ? pcCleanFieldRevisions[id]
                    : pcFieldRevisions[id];
            }
            return baseline;
        }

        function pcMarkFieldsClean(ids = Object.keys(pcCleanFieldRevisions), revisions = null) {
            ids.forEach(id => {
                if (!Object.hasOwn(pcCleanFieldRevisions, id)) return;
                pcCleanFieldRevisions[id] = revisions?.[id] ?? pcFieldRevisions[id];
            });
        }

        function pcInvalidateLoadedForm() {
            pcLoadedForm = null;
        }


        function pcTargetSelectionChanged() {
            pcTargetSelectionEpoch += 1;
            pcPendingRetry = null;
            pcInvalidateLoadedForm();
            pcMarkFieldsClean();
        }

        function pcObserveTargetSelection() {
            const target = document.getElementById('slot-target-ip')?.value || '';
            if (pcTargetObserved && target === pcObservedTarget) return false;
            pcObservedTarget = target;
            if (!pcTargetObserved) {
                pcTargetObserved = true;
                return false;
            }
            pcTargetSelectionChanged();
            return true;
        }

        function pcBindFormRevisionTracking() {
            for (const id of ['slot-cfg-0', 'slot-port', 'slot-listen-host']) {
                const field = document.getElementById(id);
                if (!field || field.dataset.pcFormRevisionBound === '1') continue;
                field.addEventListener('input', pcBumpUserEdit);
                field.dataset.pcFormRevisionBound = '1';
            }
        }

        function pcManagedServers() {
            return window.kuiManagedServers?.() || (window.kuiManagedServerIps?.() || []).map(ip => ({ name: '', ip }));
        }

        function pcTargetsForCurrentSelection() {
            const selected = document.getElementById('slot-target-ip')?.value || '';
            const targets = pcManagedServers().map(server => server.ip);
            return selected === '*' ? targets : (selected ? [selected] : []);
        }

        function pcCaptureFormRequestState(targets = null, writeVersions = null) {
            pcBindFormRevisionTracking();
            pcBindListenHostDirtyTracking();
            return {
                revision: pcFormRevision,
                userRevision: pcFormUserRevision,
                fieldRevisions: pcBaselineFieldRevisions(pcFieldRevisions, pcTargetSelectionEpoch),
                selectionEpoch: pcTargetSelectionEpoch,
                target: document.getElementById('slot-target-ip')?.value || '',
                targets: Array.isArray(targets) ? [...targets] : null,
                signature: pcLoadedTargetSignature(targets),
                configEpoch: pcConfigEpoch,
                writeVersions: writeVersions || null,
            };
        }

        function pcCaptureWriteState(targets = null) {
            const state = pcCaptureFormRequestState(targets);
            state.target = document.getElementById('slot-target-ip')?.value || '';
            state.writeSeq = pcWriteEpoch + 1;
            return state;
        }

        function pcFormRequestStillCurrent(state) {
            if (!state) return false;
            if (state.configEpoch !== undefined && state.configEpoch !== pcConfigEpoch) return false;
            if (pcFormRevision !== state.revision) return false;
            const currentTarget = document.getElementById('slot-target-ip')?.value || '';
            if (currentTarget !== state.target) return false;
            if (state.targetIp !== undefined) {
                const currentTargetIp = currentTarget === '*'
                    ? (pcManagedServers()[0]?.ip || '')
                    : currentTarget;
                if (currentTargetIp !== state.targetIp) return false;
            }
            if (!state.targets) return true;
            const currentTargets = pcTargetsForCurrentSelection();
            return currentTargets.length === state.targets.length
                && currentTargets.every((ip, index) => ip === state.targets[index]);
        }

        function pcFormSelectionStillCurrent(state) {
            if (!state) return false;
            const currentTarget = document.getElementById('slot-target-ip')?.value || '';
            if (state.target !== undefined && currentTarget !== state.target) return false;
            if (!state.targets) return true;
            const currentTargets = pcTargetsForCurrentSelection();
            return currentTargets.length === state.targets.length
                && currentTargets.every((ip, index) => ip === state.targets[index]);
        }

        function pcResetListenHostDirty() {
            const field = pcListenHostField();
            if (!field) return;
            field.dataset.pcListenDirty = '0';
        }

        function pcIsListenHostDirty() {
            const field = pcListenHostField();
            if (!field) return false;
            return field.dataset.pcListenDirty === '1';
        }

        function pcBindListenHostDirtyTracking() {
            const field = pcListenHostField();
            if (!field || field.dataset.pcListenDirtyBound === '1') return;
            field.addEventListener('input', () => {
                field.dataset.pcListenDirty = '1';
                pcBumpUserEdit('slot-listen-host');
            });
            field.dataset.pcListenDirtyBound = '1';
            if (field.dataset.pcListenDirty === undefined) field.dataset.pcListenDirty = '0';
        }

        function pcReadConfigForm() {
            const cfg0 = document.getElementById('slot-cfg-0');
            const portEl = document.getElementById('slot-port');
            const listenHostEl = document.getElementById('slot-listen-host');
            pcBindFormRevisionTracking();
            pcBindListenHostDirtyTracking();
            const rawCountry = String(cfg0?.value ?? '').trim();
            const val = rawCountry ? normalizePcCountry(rawCountry) : 'JP';
            const port = parseInt(portEl?.value) || 7920;
            const listenHost = normalizePcListenHost(listenHostEl?.value);
            const listenDirty = pcIsListenHostDirty();
            if (!isValidPcCountry(val)) {
                alert('❌ 目标地区必须是 2 位国家码或 ANY');
                return null;
            }
            if (!isValidPcListenHost(listenHost)) {
                alert('❌ 监听地址必须是 IPv4、* 或留空，例如 172.17.0.1');
                return null;
            }
            if (cfg0) cfg0.value = val;
            const isPublicListener = listenHost === '*';
            if (listenHostEl) listenHostEl.value = isPublicListener ? '*' : (listenHost || '127.0.0.1');
            return {
                cfg0,
                portEl,
                listenHostEl,
                country: val,
                port,
                listenHost,
                listenDirty,
                isPublicListener,
            };
        }

        function pcFormPayload(form) {
            return {
                '0': form.country,
                port: form.port,
                ...pcListenHostPayload(form.listenDirty),
            };
        }

        function pcLoadedTargetSignature(targets) {
            return Array.isArray(targets) ? targets.join('\n') : '';
        }

        function pcSetLoadedForm(targets) {
            pcLoadedForm = {
                target: document.getElementById('slot-target-ip')?.value || '',
                targets: Array.isArray(targets) ? [...targets] : [],
                signature: pcLoadedTargetSignature(targets),
            };
        }

        export function pcInvalidateLoadedConfig() {
            pcObserveTargetSelection();
            pcInvalidateLoadedForm();
            pcConfigEpoch += 1;
        }

        function pcRequireIdleWrites(targets) {
            if (!pcTargetsWriting(targets)) return true;
            alert('⏳ 所选 VPS 正在执行写入，请等待当前操作完成后再提交');
            return false;
        }

        function pcRequireLoadedForm() {
            const target = document.getElementById('slot-target-ip')?.value || '';
            const targets = pcTargetsForCurrentSelection();
            if (!pcLoadedForm
                || pcLoadedForm.target !== target
                || pcLoadedForm.signature !== pcLoadedTargetSignature(targets)) {
                alert('⏳ 目标 VPS 配置尚未加载完成，请等待加载后再下发或切换');
                return false;
            }
            return true;
        }

        function pcSelectWriteTargets(kind, mode = 'hot', options = {}) {
            pcPopulateTargets();
            const currentSignature = pcLoadedTargetSignature(pcTargetsForCurrentSelection());
            const retry = options.allowRetry && kind === 'switch' && pcPendingRetry?.kind === 'switch'
                && pcPendingRetry.formRevision === pcFormUserRevision
                && pcPendingRetry.mode === mode
                && pcPendingRetry.targets.length > 0
                && (
                    pcPendingRetry.signature === currentSignature
                    || pcPendingRetry.originalSignature === currentSignature
                    || pcLoadedTargetSignature(pcPendingRetry.ips) === currentSignature
                )
                    ? pcPendingRetry
                    : null;
            return retry ? retry.ips.slice() : pcSelectedTargets();
        }

        function pcBeginWrites(targets, fieldRevisions = null) {
            targets.forEach(ip => {
                pcActiveWrites.set(ip, (pcActiveWrites.get(ip) || 0) + 1);
                pcWriteVersions.set(ip, (pcWriteVersions.get(ip) || 0) + 1);
                if (fieldRevisions) pcWriteFieldBaselines.set(ip, { ...fieldRevisions });
            });
        }

        function pcEndWrites(targets) {
            targets.forEach(ip => {
                const pending = (pcActiveWrites.get(ip) || 0) - 1;
                if (pending > 0) pcActiveWrites.set(ip, pending);
                else {
                    pcActiveWrites.delete(ip);
                    pcWriteFieldBaselines.delete(ip);
                }
            });
            pcScheduleOverlappingResume();
        }

        function pcTargetsWriting(targets) {
            return targets.some(ip => (pcActiveWrites.get(ip) || 0) > 0);
        }

        function pcAnyWritesActive() {
            return pcActiveWrites.size > 0;
        }

        function pcWriteVersionSnapshot(targets) {
            const snapshot = {};
            targets.forEach(ip => {
                snapshot[ip] = pcWriteVersions.get(ip) || 0;
            });
            return snapshot;
        }

        function pcTargetMissingWrites(snapshot) {
            return Object.entries(snapshot || {}).filter(([ip, version]) => (pcWriteVersions.get(ip) || 0) > version);
        }

        function pcScheduleDeferredReload(requestState) {
            pcDeferredReload = { ...requestState, needsResume: true };
        }

        function pcScheduleRefreshReload(requestState) {
            if (!pcRefreshReload || requestState.loadSeq >= pcRefreshReload.loadSeq) {
                pcRefreshReload = {
                    ...requestState,
                    formRevision: pcFormRevision,
                    needsResume: true,
                };
            }
            pcScheduleOverlappingResume();
        }

        function pcRefreshReloadStillCurrent(pending) {
            if (!pending || typeof document === 'undefined') return false;
            const currentTarget = document.getElementById('slot-target-ip')?.value || '';
            if (!currentTarget || pending.target !== currentTarget) return false;
            const currentTargets = pcTargetsForCurrentSelection();
            if (pending.targets && !pcSameWriteTargetSet(pending.targets, currentTargets)) return false;
            return pending.selectionEpoch === pcTargetSelectionEpoch
                || (pending.formRevision === pcFormRevision && !pcAnyWritesActive());
        }

        async function pcResumeRefreshReload() {
            const pending = pcRefreshReload;
            if (!pending || pcAnyWritesActive()) return { ok: true, skipped: true };
            if (pcRefreshReload === pending) pcRefreshReload = null;
            if (!pcRefreshReloadStillCurrent(pending)) return { ok: true, skipped: true };
            const backgroundToken = pcTrackBackgroundReload(pcLoadSeq + 1);
            try {
                await pcLoadConfig(true, {
                    silent: true,
                    fieldBaseline: pending.fieldRevisions,
                    deferredReload: true,
                });
                pcSettleBackgroundReload(backgroundToken, { ok: true });
                return { ok: true };
            } catch (error) {
                pcSettleBackgroundReload(backgroundToken, { ok: false, error });
                return { ok: false, error };
            } finally {
                if (pcRefreshReload === pending) pcRefreshReload = null;
            }
        }

        async function pcReloadAfterWrite(fieldBaseline) {
            pcRefreshReload = null;
            pcDeferredReload = null;
            const backgroundToken = pcTrackBackgroundReload(pcLoadSeq + 1);
            const reload = pcLoadConfig(true, { silent: true, fieldBaseline, deferredReload: true });
            pcDeferredReloadPromise = reload;
            try {
                await reload;
                pcSettleBackgroundReload(backgroundToken, { ok: true });
                return { ok: true };
            } catch (error) {
                pcSettleBackgroundReload(backgroundToken, { ok: false, error });
                return { ok: false, error };
            } finally {
                if (pcDeferredReloadPromise === reload) pcDeferredReloadPromise = null;
            }
        }

        function pcReportPostWriteReload(result, actionLabel = '切换') {
            if (result?.ok !== false) return;
            pcDeferredReloadReported = result;
            const message = result.error?.message || String(result.error || '未知错误');
            alert(`⚠️ ${actionLabel}指令已下发成功，但配置读取失败：${message}\n请稍后刷新页面或重新加载目标 VPS 配置。`);
        }

        function pcReportPostWriteReloadOnce(result, actionLabel = '切换') {
            if (result?.ok !== false || result?.error === pcDeferredReloadReported?.error) return;
            pcReportPostWriteReload(result, actionLabel);
        }

        function pcTrackBackgroundReload(seq) {
            const token = ++pcBackgroundReloadSeq;
            pcBackgroundReloadReporters.set(token, seq);
            return token;
        }

        function pcCurrentPendingBackgroundReload() {
            const reload = pcDeferredReloadPromise;
            if (!reload) return null;
            return reload.then(
                () => ({ ok: true }),
                error => ({ ok: false, error }),
            );
        }

        function pcSettleBackgroundReload(token, result) {
            const seq = pcBackgroundReloadReporters.get(token);
            if (seq === undefined) return;
            pcBackgroundReloadReporters.delete(token);
            if (seq < pcLoadSeq) return;
            pcReportPostWriteReloadOnce(result, '代理');
        }

        async function pcSettleRefreshLoad(loadSeq, requestState, schedule) {
            if (schedule && requestState) pcScheduleRefreshReload(requestState);
            pcPendingRefreshLoads.delete(loadSeq);
            if (pcAnyWritesActive() || pcPendingRefreshLoads.size > 0 || !pcRefreshReload) return;
            return pcResumeRefreshReload();
        }

        function pcLoadSuperseded(loadSeq) {
            return loadSeq < pcLoadSeq || loadSeq < pcAppliedLoadSeq;
        }

        async function pcDiscardSupersededLoad(loadSeq) {
            if (!pcPendingRefreshLoads.has(loadSeq)) return;
            await pcSettleRefreshLoad(loadSeq, null, false);
        }

        function pcScheduleOverlappingResume() {
            if (pcResumeTimer || (!pcDeferredReload && !pcRefreshReload && pcPendingRefreshLoads.size === 0)) return;
            pcResumeTimer = setTimeout(() => {
                pcResumeTimer = null;
                if (typeof document === 'undefined') return;
                if (pcAnyWritesActive() || (!pcDeferredReload && !pcRefreshReload && pcPendingRefreshLoads.size === 0)) return;
                pcResumeAfterOverlappingWrites()
                    .then(result => pcReportPostWriteReloadOnce(result, '代理'))
                    .catch(error => {
                        console.warn('[pc] deferred reload failed:', error);
                    });
            }, 0);
        }

        function pcSameWriteTargetSet(left, right) {
            const leftTargets = Array.isArray(left) ? left : [];
            const rightTargets = Array.isArray(right) ? right : [];
            return leftTargets.length === rightTargets.length
                && leftTargets.every((ip, index) => ip === rightTargets[index]);
        }

        async function pcResumeAfterOverlappingWrites() {
            if (typeof document === 'undefined') return;
            const refreshResult = pcRefreshReload ? await pcResumeRefreshReload() : null;
            const pending = pcDeferredReload;
            if (!pending) return refreshResult;
            if (pending.objective === 'write' && !pcAnyWritesActive()) {
                pcDeferredReload = null;
                return refreshResult;
            }
            const currentTarget = document.getElementById('slot-target-ip')?.value || '';
            const currentTargets = pcTargetsForCurrentSelection();
            if (!currentTarget) return refreshResult;
            if (pending.objective === 'write' && pending.target === currentTarget
                && pcSameWriteTargetSet(pending.targets, currentTargets)) {
                pcDeferredReload = null;
            }
            if (pending.target === currentTarget
                && (!pending.targets || pcSameWriteTargetSet(pending.targets, currentTargets))
                && pending.selectionEpoch === pcTargetSelectionEpoch) {
                pcDeferredReload = null;
            }
            if (pending.target && currentTarget !== pending.target) {
                pcDeferredReload = {
                    target: currentTarget,
                    targets: currentTargets,
                    revision: pcFormRevision,
                    userRevision: pending.userRevision,
                    fieldRevisions: pending.fieldRevisions,
                    selectionEpoch: pcTargetSelectionEpoch,
                    loadSeq: pending.loadSeq,
                    needsResume: true,
                };
            } else if (pending.targets && !pcSameWriteTargetSet(pending.targets, currentTargets)) {
                pcDeferredReload = {
                    target: currentTarget,
                    targets: currentTargets,
                    revision: pcFormRevision,
                    userRevision: pending.userRevision,
                    fieldRevisions: pending.fieldRevisions,
                    selectionEpoch: pcTargetSelectionEpoch,
                    loadSeq: pending.loadSeq,
                    needsResume: true,
                };
            }
            pcDeferredReload = null;
            const backgroundToken = pcTrackBackgroundReload(pcLoadSeq + 1);
            const reload = pcLoadConfig(true, {
                silent: true,
                fieldBaseline: pending.fieldRevisions,
                deferredReload: true,
            });
            pcDeferredReloadPromise = reload;
            try {
                await reload;
                pcSettleBackgroundReload(backgroundToken, { ok: true });
                pcReportPostWriteReloadOnce(refreshResult, '代理');
                return { ok: true };
            } catch (error) {
                pcSettleBackgroundReload(backgroundToken, { ok: false, error });
                pcReportPostWriteReloadOnce(refreshResult, '代理');
                return { ok: false, error };
            } finally {
                if (pcDeferredReloadPromise === reload) pcDeferredReloadPromise = null;
            }
        }

        async function pcDiscardDeferredReload(loadSeq) {
            if (!pcDeferredReload) return;
            if (loadSeq !== undefined && pcDeferredReload.loadSeq !== loadSeq) return;
            pcDeferredReload = null;
        }

        function pcStartBatchWithBaseline(targets, fieldRevisions) {
            pcBeginWrites(targets, fieldRevisions);
            return async task => {
                try {
                    return await task();
                } finally {
                    pcEndWrites(targets);
                }
            };
        }

        function pcTelemetryNumber(value) {
            if (value === undefined || value === null || typeof value === 'boolean' || Array.isArray(value) || typeof value === 'object') return null;
            if (typeof value === 'string' && !value.trim()) return null;
            const number = Number(value);
            return Number.isFinite(number) && number >= 0 ? number : null;
        }

        export function formatPcSpeed(value) {
            const kbps = pcTelemetryNumber(value);
            if (kbps === null) return '';
            if (kbps >= 1000) {
                return `${(kbps / 1000).toFixed(1)} Mbps`;
            }
            return `${Math.round(kbps)} kbps`;
        }

        export function formatPcDuration(value) {
            const seconds = pcTelemetryNumber(value);
            if (seconds === null) return '';
            const total = Math.floor(seconds);
            if (total < 60) return `${total}s`;
            const hours = Math.floor(total / 3600);
            const minutes = Math.floor((total % 3600) / 60);
            if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
            return `${minutes}m ${String(total % 60).padStart(2, '0')}s`;
        }

        function pcPurityToneClasses(tone) {
            if (tone === 'emerald') return 'border-emerald-500/30 bg-emerald-500/15 text-emerald-300';
            if (tone === 'sky') return 'border-sky-500/30 bg-sky-500/15 text-sky-300';
            if (tone === 'amber') return 'border-amber-500/30 bg-amber-500/15 text-amber-300';
            if (tone === 'rose') return 'border-rose-500/30 bg-rose-500/15 text-rose-300';
            return 'border-slate-700/70 bg-slate-900/70 text-slate-300';
        }

        export function pcTunnelTelemetryBadges(detail) {
            if (!detail || typeof detail !== 'object') return '';
            const badges = [];
            const purity = formatExitPurityMeta(detail);
            if (purity) {
                if (purity.typeLabel) {
                    const titleAttr = purity.asnOrg ? ` title="${pcEscapeHtml(purity.asnOrg)}"` : '';
                    badges.push(`<span class="pc-tunnel-badge pc-tunnel-badge-purity inline-flex items-center whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] font-medium ${pcPurityToneClasses(purity.typeTone)}"${titleAttr}>${pcEscapeHtml(purity.typeLabel)}</span>`);
                }
                if (purity.fraudScore !== null) {
                    badges.push(`<span class="pc-tunnel-badge pc-tunnel-badge-risk inline-flex items-center whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] font-mono ${pcPurityToneClasses(purity.fraudTone)}">IPPure ${purity.fraudScore}</span>`);
                }
                if (purity.ipokRisk !== null) {
                    badges.push(`<span class="pc-tunnel-badge pc-tunnel-badge-risk inline-flex items-center whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] font-mono ${pcPurityToneClasses(purity.ipokTone)}">IPOK ${purity.ipokRisk}</span>`);
                }
            }
            const ttfb = pcTelemetryNumber(detail.ttfb_ms);
            const speed = formatPcSpeed(detail.speed_kbps);
            const connectedSeconds = pcTelemetryNumber(detail.connected_time);
            const connected = connectedSeconds !== null && connectedSeconds > 0 ? formatPcDuration(connectedSeconds) : '';
            if (ttfb !== null) {
                badges.push(`<span class="pc-tunnel-badge pc-tunnel-badge-ttfb inline-flex items-center whitespace-nowrap rounded border border-slate-700/70 bg-slate-900/70 px-1.5 py-0.5 text-[10px] font-mono text-slate-300">首包 ${Math.round(ttfb)}ms</span>`);
            }
            if (speed) {
                badges.push(`<span class="pc-tunnel-badge pc-tunnel-badge-speed inline-flex items-center whitespace-nowrap rounded border border-sky-500/20 bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-mono text-sky-300">吞吐 ${speed}</span>`);
            }
            if (detail.ready === true) {
                badges.push('<span class="pc-tunnel-badge pc-tunnel-badge-ready inline-flex items-center whitespace-nowrap rounded border border-emerald-500/20 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-mono text-emerald-300">就绪</span>');
            }
            if (connected) {
                badges.push(`<span class="pc-tunnel-badge pc-tunnel-badge-connected inline-flex items-center whitespace-nowrap rounded border border-violet-500/20 bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-mono text-violet-300">已连 ${connected}</span>`);
            }
            return badges.length ? `<span class="pc-tunnel-telemetry inline-flex min-w-0 max-w-full flex-wrap items-center gap-1">${badges.join('')}</span>` : '';
        }

        function pcNotifyRealtime(ip) {
            try {
                const pending = window.kuiNotifyRealtime?.(ip);
                if (pending && typeof pending.catch === 'function') pending.catch(() => {});
            } catch (_) {}
        }

        export function pcParseTunnelDetails(value) {
            let details = value;
            if (typeof details === 'string') {
                try { details = JSON.parse(details || '[]'); } catch (_) { details = []; }
            }
            return Array.isArray(details) ? details.filter(detail => detail && typeof detail === 'object') : [];
        }

        function pcSampleTimestamp(source) {
            const candidates = [
                source?.proxy_updated_at,
                source?.proxy?.updated_at,
                source?.proxy?.sampled_at,
                source?.proxy_last_seen,
                source?.proxy?.last_seen,
                source?.last_seen,
                source?.updated_at,
                source?.ts,
            ];
            for (const value of candidates) {
                const timestamp = Number(value);
                if (!Number.isFinite(timestamp) || timestamp <= 0) continue;
                return timestamp < 1e12 ? timestamp * 1000 : timestamp;
            }
            return 0;
        }

        export function pcMergeRealtimeServer(server, snapshot) {
            const previous = server && typeof server === 'object' ? server : {};
            const realtimeDetails = Array.isArray(snapshot?.proxy?.details) ? snapshot.proxy.details : null;
            const realtimeTs = pcSampleTimestamp(snapshot);
            const httpTs = Number(previous._pc_http_sample_ts || pcSampleTimestamp(previous) || 0);
            const realtimeAppliedTs = Number(previous._pc_realtime_sample_ts || 0);
            if (realtimeDetails !== null && realtimeTs > 0 && httpTs > 0 && realtimeTs < httpTs) return previous;
            if (realtimeDetails !== null && realtimeTs > 0 && realtimeAppliedTs > 0 && realtimeTs < realtimeAppliedTs) return previous;
            const lastSeen = realtimeTs || Number(snapshot?.proxy_last_seen || snapshot?.updated_at || 0) || previous.last_seen;
            const logs = snapshot?.proxy?.logs || previous.logs || '';
            return {
                ...previous,
                ip: snapshot?.ip || previous.ip,
                details: realtimeDetails !== null ? JSON.stringify(realtimeDetails) : previous.details || '[]',
                last_seen: lastSeen,
                logs,
                _pc_realtime_sample_ts: realtimeTs || previous._pc_realtime_sample_ts || 0,
            };
        }

        async function getPcAuthHeader(method, path) {
            const user = sessionStorage.getItem('kui_user') || 'admin';
            const key = sessionStorage.getItem('kui_auth_key') || '';
            if (!key) return '';
            return `Bearer ${key}`;
        }

        export function pcPopulateTargets() {
            const select = document.getElementById('slot-target-ip');
            if (!select) return [];
            const managedServers = pcManagedServers();
            const targets = managedServers.map(server => server.ip);
            const previous = select.value;
            const signature = managedServers.map(server => `${server.ip}\u0000${server.name || ''}`).join('\n');
            if (select.dataset.pcTargetsSignature !== signature) {
                select.innerHTML = targets.length
                    ? managedServers.map(server => `<option value="${pcEscapeHtml(server.ip)}">${pcEscapeHtml(server.name || server.ip)} : ${pcEscapeHtml(server.ip)}</option>`).join('') + (targets.length > 1 ? '<option value="*">全部 VPS</option>' : '')
                    : '<option value="">暂无 VPS</option>';
                select.dataset.pcTargetsSignature = signature;
                pcInvalidateLoadedForm();
            }
            const nextValue = (previous === '*' || targets.includes(previous)) ? previous : (targets[0] || '');
            if (select.value !== nextValue) {
                select.value = nextValue;
                pcInvalidateLoadedForm();
            }
            if (select.dataset.pcTargetChangeBound !== '1') {
                select.addEventListener('change', () => {
                    pcObserveTargetSelection();
                });
                select.dataset.pcTargetChangeBound = '1';
            }
            return targets;
        }

        function pcSelectedTargets() {
            const targets = pcPopulateTargets();
            const selected = document.getElementById('slot-target-ip')?.value || '';
            return selected === '*' ? targets : (selected ? [selected] : []);
        }

        export function pcSyncCountrySelection() {
            const input = document.getElementById('slot-cfg-0');
            const container = document.getElementById('countries-list');
            const selected = normalizePcCountry(input?.value);
            const chips = container?.querySelectorAll?.('[data-country-code]') || [];
            chips.forEach(chip => {
                const active = !!selected && normalizePcCountry(chip.dataset.countryCode) === selected;
                chip.classList?.toggle('pc-country-chip-active', active);
                if (chip.style) {
                    chip.style.borderColor = active ? '#818cf8' : '';
                    chip.style.backgroundColor = active ? 'rgba(99, 102, 241, 0.24)' : '';
                    chip.style.color = active ? '#c7d2fe' : '';
                    chip.style.boxShadow = active ? '0 0 0 2px rgba(99, 102, 241, 0.28)' : '';
                }
                chip.setAttribute?.('aria-pressed', active ? 'true' : 'false');
            });
        }

        function pcRenderCountryShortcuts(container, entries) {
            const anyChip = '<button type="button" data-country-code="ANY" title="选择 ANY，自动优选全球最快节点" class="pc-country-chip pc-country-chip-any">ANY<span class="ml-1 text-indigo-300">自动优选</span></button>';
            const unavailable = entries.some(item => item.nodes === null)
                ? '<span class="w-full text-sm text-rose-500">节点数量读取失败，请稍后刷新</span>' : '';
            container.innerHTML = unavailable + anyChip + entries.map(item => {
                const code = pcEscapeHtml(item.code);
                const count = item.nodes === null ? '—' : item.nodes;
                const countClass = item.nodes === null ? 'text-slate-500' : (item.nodes > 0 ? 'text-emerald-400' : 'text-rose-400');
                return `<button type="button" data-country-code="${code}" title="选择 ${code}，候选节点 ${count} 个" class="pc-country-chip">${code}<span class="ml-1 ${countClass}">${count}</span></button>`;
            }).join('');
            container.onclick = event => {
                const button = event.target.closest('[data-country-code]');
                const input = document.getElementById('slot-cfg-0');
                const country = normalizePcCountry(button?.dataset.countryCode);
                if (button && input && country) {
                    pcBindFormRevisionTracking();
                    input.value = country;
                    pcBumpUserEdit('slot-cfg-0');
                    pcSyncCountrySelection();
                    input.focus();
                }
            };
            const input = document.getElementById('slot-cfg-0');
            if (input && input.dataset.pcCountrySync !== '1') {
                input.addEventListener('input', event => {
                    const target = event?.target || input;
                    const normalized = pcNormalizeCountryInput(target.value);
                    if (target.value !== normalized) target.value = normalized;
                    pcSyncCountrySelection();
                });
                input.dataset.pcCountrySync = '1';
            }
            pcSyncCountrySelection();
        }

        export async function pcFetchCountries(throwOnError = false) {
            const container = document.getElementById('countries-list');
            if (!container) return;
            if (!container.dataset.pcCountryInitialized) {
                pcRenderCountryShortcuts(container, []);
                container.dataset.pcCountryInitialized = '1';
            }
            try {
                const auth = await getPcAuthHeader('GET', '/api/proxy/countries');
                const res = await fetch('/api/proxy/countries', { headers: { 'Authorization': auth } });
                const list = await res.json();
                const entries = Array.isArray(list) ? list.map(item => {
                    if (typeof item === 'string') return { code: item.toUpperCase(), nodes: null };
                    return { code: String(item?.code || item?.country || '').toUpperCase(), nodes: item?.nodes != null && Number.isFinite(Number(item.nodes)) ? Number(item.nodes) : null };
                }).filter(item => /^[A-Z]{2}$/.test(item.code)).sort((a, b) => {
                    const nodeDelta = (b.nodes ?? -1) - (a.nodes ?? -1);
                    return nodeDelta || a.code.localeCompare(b.code, 'en');
                }) : [];
                pcRenderCountryShortcuts(container, entries);
            } catch(e) {
                console.warn('[pc] countries failed:', e);
                if (throwOnError) throw e;
            }
        }

        export async function pcLoadConfig(throwOnError = false, expectations = {}) {
            const loadSeq = ++pcLoadSeq;
            let requestState = null;
            let isDeferredReload = false;
            try {
                const targets = Array.isArray(expectations.expectedTargets)
                    ? [...expectations.expectedTargets]
                    : pcPopulateTargets();
                pcObserveTargetSelection();
                const selected = expectations.target !== undefined
                    ? expectations.target
                    : (document.getElementById('slot-target-ip')?.value || '');
                const targetIp = selected === '*' ? targets[0] : selected;
                if (!targetIp) throw new Error('暂无已接入 VPS');
                const loadTargets = selected === '*' ? [...targets] : [targetIp];
                const startedDuringWrite = pcTargetsWriting(loadTargets);
                const writeVersions = pcWriteVersionSnapshot(loadTargets);
                isDeferredReload = !!expectations.deferredReload;
                requestState = pcCaptureFormRequestState(loadTargets, writeVersions);
                if (expectations.fieldBaseline) {
                    requestState.fieldRevisions = { ...expectations.fieldBaseline };
                }
                if (startedDuringWrite) {
                    const activeBaselines = loadTargets
                        .map(ip => pcWriteFieldBaselines.get(ip))
                        .filter(Boolean);
                    Object.keys(requestState.fieldRevisions).forEach(id => {
                        const revisions = activeBaselines
                            .map(baseline => baseline[id])
                            .filter(Number.isFinite);
                        if (revisions.length) {
                            requestState.fieldRevisions[id] = Math.min(requestState.fieldRevisions[id], ...revisions);
                        }
                    });
                }
                const baselineSelectionEpoch = requestState.selectionEpoch;
                Object.keys(requestState.fieldRevisions).forEach(id => {
                    if (pcFieldEpochs[id] !== baselineSelectionEpoch) {
                        requestState.fieldRevisions[id] = pcFieldRevisions[id];
                    }
                });
                requestState = { ...requestState, target: selected };
                requestState.targetIp = targetIp;
                requestState.loadSeq = loadSeq;
                requestState.startedDuringWrite = startedDuringWrite;
                if (startedDuringWrite) pcPendingRefreshLoads.add(loadSeq);
                const auth = await getPcAuthHeader('GET', '/api/proxy/config');
                const res = await fetch(`/api/proxy/config?ip=${encodeURIComponent(targetIp)}`, { headers: { 'Authorization': auth } });
                if (pcLoadSuperseded(loadSeq)) {
                    if (requestState.startedDuringWrite || pcAnyWritesActive()) {
                        requestState.objective = 'refresh';
                        await pcSettleRefreshLoad(loadSeq, requestState, true);
                    } else {
                        await pcDiscardSupersededLoad(loadSeq);
                    }
                    return;
                }
                if (!res.ok) {
                    const err = await res.text();
                    const writesAdvanced = pcTargetMissingWrites(requestState.writeVersions).length > 0;
                    if (startedDuringWrite || writesAdvanced) {
                        requestState.objective = 'refresh';
                        await pcSettleRefreshLoad(loadSeq, requestState, true);
                    } else {
                        await pcSettleRefreshLoad(loadSeq, requestState, false);
                    }
                    throw new Error(err || res.status);
                }
                const map = await res.json();
                if (pcLoadSuperseded(loadSeq)) {
                    if (requestState.startedDuringWrite || pcAnyWritesActive()) {
                        requestState.objective = 'refresh';
                        await pcSettleRefreshLoad(loadSeq, requestState, true);
                    } else {
                        await pcDiscardSupersededLoad(loadSeq);
                    }
                    return;
                }
                const writesAdvanced = pcTargetMissingWrites(requestState.writeVersions).length > 0;
                const blockedByWrite = startedDuringWrite || writesAdvanced || pcTargetsWriting(loadTargets);
                if (blockedByWrite) {
                    requestState.objective = startedDuringWrite ? 'refresh' : 'write';
                    if (startedDuringWrite) {
                        await pcSettleRefreshLoad(loadSeq, requestState, true);
                    } else {
                        pcPendingRefreshLoads.delete(loadSeq);
                        pcScheduleDeferredReload(requestState);
                    }
                    if (!startedDuringWrite && !pcAnyWritesActive()) {
                        pcScheduleOverlappingResume();
                    }
                    return;
                }
                if (pcLoadSuperseded(loadSeq)) return;
                const currentTarget = document.getElementById('slot-target-ip')?.value || '';
                const currentTargets = pcTargetsForCurrentSelection();
                if (currentTarget !== selected || !pcSameWriteTargetSet(currentTargets, loadTargets)) return;
                if (requestState.selectionEpoch !== pcTargetSelectionEpoch) {
                    return;
                }
                const cfg0 = document.getElementById('slot-cfg-0');
                const port = document.getElementById('slot-port');
                const listenHost = document.getElementById('slot-listen-host');
                const editedFields = Object.entries(requestState.fieldRevisions)
                    .filter(([id, revision]) => pcFieldRevisions[id] !== revision)
                    .map(([id]) => id);
                const country = map["0"] || map.proxy?.country || 'JP';
                const normalizedCountry = normalizePcCountry(country);
                const canApplyCountry = !editedFields.includes('slot-cfg-0');
                const canApplyPort = !editedFields.includes('slot-port');
                const canApplyListenHost = !editedFields.includes('slot-listen-host');
                await pcSettleRefreshLoad(loadSeq, requestState, false);
                if (cfg0 && normalizedCountry && canApplyCountry) cfg0.value = normalizedCountry;
                if (port && canApplyPort) port.value = map["port"] || map.proxy?.port || 7920;
                if (listenHost && canApplyListenHost) listenHost.value = pcResolveListenHost(map);
                pcBindListenHostDirtyTracking();
                if (canApplyListenHost) {
                    pcResetListenHostDirty();
                }
                pcAppliedLoadSeq = loadSeq;
                pcSetLoadedForm(loadTargets);
                pcSyncCountrySelection();
                pcBumpFormRevision();
            } catch(e) {
                console.warn('[pc] loadConfig failed:', e);
                if (requestState && !pcLoadSuperseded(loadSeq)
                    && (pcPendingRefreshLoads.has(loadSeq) || pcAnyWritesActive())) {
                    requestState.objective = 'refresh';
                    pcScheduleRefreshReload(requestState);
                    pcPendingRefreshLoads.delete(loadSeq);
                } else if (requestState) {
                    pcPendingRefreshLoads.delete(loadSeq);
                }
                if (throwOnError) throw e;
            }
        }

        function pcListenHostPayload(isDirty) {
            if (!isDirty) return {};
            const listenHost = normalizePcListenHost(pcListenHostField()?.value);
            return listenHost === '*'
                ? { public_listener: true }
                : { public_listener: false, listen_host: listenHost || '127.0.0.1' };
        }

        function pcApplySavedConfig(form, text, options = {}) {
            try {
                const resp = JSON.parse(text);
                if (!resp || typeof resp !== 'object') return null;
                const slot = resp.slot_map && typeof resp.slot_map === 'object' ? resp.slot_map : null;
                const proxy = resp.proxy && typeof resp.proxy === 'object' ? resp.proxy : null;
                const saved = slot || proxy || resp;
                const fieldRevisions = options.fieldRevisions;
                const fieldValues = options.fieldValues || null;
                const editedFields = fieldRevisions
                    ? Object.entries(fieldRevisions)
                        .filter(([id, revision]) => pcFieldRevisions[id] !== revision)
                        .map(([id]) => id)
                    : [];
                const savedCountry = normalizePcCountry(saved["0"] || saved.country || proxy?.country || resp.country || resp["0"]);
                const changedSinceValues = id => fieldValues
                    ? String(form[id === 'slot-cfg-0' ? 'cfg0' : id === 'slot-port' ? 'portEl' : 'listenHostEl']?.value ?? '') !== String(fieldValues[id] ?? '')
                    : false;
                if (form.cfg0 && savedCountry && !editedFields.includes('slot-cfg-0') && !changedSinceValues('slot-cfg-0')) {
                    form.cfg0.value = savedCountry;
                }
                const savedPort = Number(saved.port ?? proxy?.port ?? resp.port);
                if (form.portEl && Number.isInteger(savedPort) && savedPort > 0
                    && !editedFields.includes('slot-port') && !changedSinceValues('slot-port')) {
                    form.portEl.value = String(savedPort);
                }
                const hasListenerField = [resp, slot, proxy].some(source =>
                    source && (source.public_listener !== undefined || source.listen_host !== undefined));
                if (form.listenHostEl && hasListenerField
                    && !editedFields.includes('slot-listen-host') && !changedSinceValues('slot-listen-host')) {
                    form.listenHostEl.value = pcResolveSavedListenHost(resp, proxy);
                }
                pcSyncCountrySelection();
                return resp;
            } catch(e) {
                console.warn('[pc] parse response failed', e);
                return null;
            }
        }

        function pcBuildSavePayload(ip, form) {
            return {
                ip,
                "country": form.country,
                ...pcFormPayload(form),
            };
        }

        async function pcSendSavePayload(payload) {
            const ip = payload.ip;
            const auth = await getPcAuthHeader('POST', '/api/proxy/config');
            const res = await fetch('/api/proxy/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': auth },
                body: JSON.stringify(payload),
            });
            const text = await res.text();
            if (!res.ok) throw new Error(text || res.status);
            pcNotifyRealtime(ip);
            return { ip, text };
        }

        async function pcSaveConfigTargets(targets, form) {
            const results = await Promise.allSettled(targets.map(ip => pcSendSavePayload(pcBuildSavePayload(ip, form))));
            const succeeded = results.filter(result => result.status === 'fulfilled').map(result => result.value);
            const failed = results.map((result, index) => ({ result, ip: targets[index] })).filter(item => item.result.status === 'rejected');
            if (!succeeded.length) {
                throw new Error(failed.map(item => `${item.ip}: ${item.result.reason?.message || item.result.reason}`).join('\n'));
            }
            return { succeeded, failed };
        }

        export async function pcSaveConfig() {
            const form = pcReadConfigForm();
            if (!form) return;
            form.listenDirty = pcIsListenHostDirty();
            try {
                if (!pcRequireLoadedForm()) return;
                const targets = pcSelectWriteTargets('save');
                if (!targets.length) throw new Error('暂无已接入 VPS');
                if (!pcRequireIdleWrites(targets)) return;
                const deferredReloadAtStart = pcCurrentPendingBackgroundReload();
                const retryState = pcPendingRetry;
                pcConfigEpoch += 1;
                pcWriteEpoch += 1;
                const batchSeq = pcWriteEpoch;
                const requestState = pcCaptureWriteState(pcTargetsForCurrentSelection());
                requestState.configEpoch = pcConfigEpoch;
                const runBatch = pcStartBatchWithBaseline(targets, requestState.fieldRevisions);
                const results = await runBatch(() => pcSaveConfigTargets(targets, form));
                const { succeeded, failed } = results;
                const selectionContextChanged = requestState.selectionEpoch !== pcTargetSelectionEpoch;
                if (!failed.length && !pcFormRequestStillCurrent(requestState)
                    && (selectionContextChanged || !pcFormSelectionStillCurrent(requestState))) {
                    alert(`🚀 策略及端口已实时下发到 ${succeeded.length} 台 VPS！`);
                    if (deferredReloadAtStart) {
                        deferredReloadAtStart.then(result => pcReportPostWriteReloadOnce(result, '保存'));
                    }
                }
                const failureText = failed.map(item => `${item.ip}: ${item.result.reason?.message || item.result.reason}`).join('\n');
                if (failed.length) {
                    pcPendingRetry = batchSeq === pcWriteEpoch && pcFormSelectionStillCurrent(requestState)
                        && pcFormUserRevision === requestState.userRevision
                        && retryState?.kind === 'switch'
                        ? {
                            ...retryState,
                            formRevision: pcFormUserRevision,
                        }
                        : null;
                    alert(`⚠️ 下发完成：成功 ${succeeded.length} 台，失败 ${failed.length} 台\n${failureText}`);
                    return;
                }
                if (batchSeq === pcWriteEpoch) pcPendingRetry = null;
                if (!pcFormRequestStillCurrent(requestState)) {
                    if (pcFormSelectionStillCurrent(requestState)) {
                        if (pcDeferredReload) pcDeferredReload = null;
                    } else if (pcFormUserRevision === requestState.userRevision) {
                        const reloadResult = await pcReloadAfterWrite(requestState.fieldRevisions);
                        pcReportPostWriteReloadOnce(reloadResult, '保存');
                        return;
                    }
                    return;
                }
                await pcDiscardDeferredReload(requestState.loadSeq);
                // 直接从 POST 响应体更新输入字段，避免立即回读时 D1 最终一致性导致读到旧数据
                pcApplySavedConfig(form, succeeded[succeeded.length - 1].text);
                if (form.listenDirty) pcResetListenHostDirty();
                pcSetLoadedForm(pcTargetsForCurrentSelection());
                pcMarkFieldsClean();
                pcBumpFormRevision();
                alert(`🚀 策略及端口已实时下发到 ${succeeded.length} 台 VPS！`);
            } catch (e) { alert('❌ 下发失败: ' + e.message); }
        }

        export async function pcSwitchIP(switchMode = 'hot') {
            const mode = normalizePcSwitchMode(switchMode);
            try {
                const retryState = pcPendingRetry?.kind === 'switch'
                    && pcPendingRetry.formRevision === pcFormUserRevision
                    && pcPendingRetry.mode === mode
                    && pcPendingRetry.ips.length > 0
                    && pcPendingRetry.originalSignature === pcLoadedTargetSignature(pcTargetsForCurrentSelection())
                        ? pcPendingRetry
                        : null;
                const targets = retryState
                    ? retryState.ips.slice()
                    : pcSelectWriteTargets('switch', mode, { allowRetry: true });
                if (!targets.length) throw new Error('暂无已接入 VPS');
                if (!pcRequireLoadedForm()) return;
                if (!pcRequireIdleWrites(targets)) return;
                pcConfigEpoch += 1;
                pcWriteEpoch += 1;
                const batchSeq = pcWriteEpoch;
                const requestState = pcCaptureWriteState(pcTargetsForCurrentSelection());
                requestState.configEpoch = pcConfigEpoch;
                if (pcDeferredReload) pcDeferredReload.fieldRevisions = { ...requestState.fieldRevisions };
                const batchSignature = pcLoadedTargetSignature(targets);
                const batchTargets = [...targets];
                const form = retryState
                    ? {
                        cfg0: document.getElementById('slot-cfg-0'),
                        portEl: document.getElementById('slot-port'),
                        listenHostEl: document.getElementById('slot-listen-host'),
                        country: retryState.payload.country,
                        port: retryState.payload.port,
                        listenHost: retryState.payload.listenHost,
                        isPublicListener: retryState.payload.isPublicListener,
                        listenDirty: retryState.payload.listenDirty,
                    }
                    : pcReadConfigForm();
                if (!form) return;
                form.listenDirty = retryState
                    ? retryState.payload.listenDirty
                    : (form.listenDirty || pcIsListenHostDirty());
                const payloads = retryState
                    ? new Map(retryState.targets.map(target => [target.ip, {
                        ...target.payload,
                        switch_mode: mode,
                    }]))
                    : new Map(targets.map(ip => [ip, {
                        ip,
                        ...pcFormPayload(form),
                        switch_mode: mode,
                    }]));
                const runBatch = pcStartBatchWithBaseline(targets, requestState.fieldRevisions);
                const results = await runBatch(() => Promise.allSettled(targets.map(async ip => {
                        const url = '/api/proxy/switch';
                        const payload = payloads.get(ip);
                        const auth = await getPcAuthHeader('POST', url);
                        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': auth }, body: JSON.stringify(payload) });
                        if (!res.ok) { const err = await res.text(); throw new Error(err || res.status); }
                        pcNotifyRealtime(ip);
                        return { ip, text: await res.text() };
                    })));
                const succeeded = results.filter(result => result.status === 'fulfilled');
                const failed = results.map((result, index) => ({ result, ip: targets[index] })).filter(item => item.result.status === 'rejected');
                if (!succeeded.length) {
                    if (retryState?.kind === 'switch' && batchSeq === pcWriteEpoch
                        && pcFormSelectionStillCurrent(requestState)
                        && pcFormUserRevision === requestState.userRevision) {
                        pcPendingRetry = {
                            ...retryState,
                            targets: retryState.targets.filter(target => failed.some(item => item.ip === target.ip)),
                            ips: failed.map(item => item.ip),
                            batchSeq,
                            formRevision: pcFormUserRevision,
                        };
                    } else {
                        pcPendingRetry = null;
                    }
                    alert('❌ 下发失败: ' + failed.map(item => `${item.ip}: ${item.result.reason?.message || item.result.reason}`).join('\n'));
                    return;
                }
                const actionLabel = mode === 'full' ? '全量重拨' : '热切换';
                const retryFormInvalid = retryState?.kind === 'switch'
                    && retryState.formRevision !== pcFormUserRevision;
                if (retryFormInvalid) pcPendingRetry = null;
                if (failed.length) {
                    const failedIps = failed.map(item => item.ip);
                    const failedPayloads = failedIps.map(ip => ({
                        ip,
                        payload: payloads.get(ip),
                    }));
                    pcPendingRetry = !retryFormInvalid && batchSeq === pcWriteEpoch
                        && pcFormSelectionStillCurrent(requestState)
                        && pcFormUserRevision === requestState.userRevision
                        ? {
                            kind: 'switch',
                            batchSeq,
                            mode,
                            ips: failedIps,
                            targets: failedPayloads,
                            payload: pcFormPayload(form),
                            signature: pcLoadedTargetSignature(failedIps),
                            originalSignature: retryState?.kind === 'switch'
                                ? retryState.originalSignature
                                : batchSignature,
                            originalTargets: retryState?.kind === 'switch'
                                ? retryState.originalTargets
                                : batchTargets,
                            complete: false,
                            formRevision: pcFormUserRevision,
                        }
                        : null;
                    alert(`⚠️ ${actionLabel}完成：成功 ${succeeded.length} 台，失败 ${failed.length} 台\n${failed.map(item => `${item.ip}: ${item.result.reason?.message || item.result.reason}`).join('\n')}`);
                    return;
                }
                if (pcPendingRetry?.kind === 'switch' && batchSeq === pcWriteEpoch
                    && pcFormRequestStillCurrent(requestState)) {
                    pcPendingRetry = null;
                } else if (batchSeq === pcWriteEpoch) {
                    pcPendingRetry = null;
                }
                const formStillCurrent = pcFormRequestStillCurrent(requestState);
                const selectionStillCurrent = requestState.selectionEpoch === pcTargetSelectionEpoch;
                const explicitReload = pcDeferredReload?.objective === 'write';
                const pendingRefresh = pcRefreshReload?.target === requestState.target
                    && pcRefreshReload.selectionEpoch >= requestState.selectionEpoch;
                let reloadResult = null;
                if (formStillCurrent && selectionStillCurrent) {
                    if (pendingRefresh && pcFormUserRevision !== requestState.userRevision) {
                        reloadResult = await pcResumeRefreshReload();
                    } else {
                        pcApplySavedConfig(form, succeeded[succeeded.length - 1].value.text);
                        pcResetListenHostDirty();
                        pcMarkFieldsClean();
                        pcBumpFormRevision();
                        pcRefreshReload = null;
                        if (pcDeferredReload && !explicitReload) pcDeferredReload = null;
                    }
                } else if (selectionStillCurrent) {
                    if (pcFormSelectionStillCurrent(requestState)) {
                        pcRefreshReload = null;
                        if (pcDeferredReload && !explicitReload) pcDeferredReload = null;
                    } else if (pcFormUserRevision === requestState.userRevision) {
                        reloadResult = await pcReloadAfterWrite(requestState.fieldRevisions);
                    } else if (pcDeferredReload && !explicitReload) {
                        pcDeferredReload = null;
                    }
                } else {
                    reloadResult = await pcReloadAfterWrite(requestState.fieldRevisions);
                }
                alert(`🔄 ${actionLabel}指令已实时下发到 ${succeeded.length} 台 VPS！`);
                pcReportPostWriteReloadOnce(reloadResult);
            } catch (e) {
                alert('❌ 下发失败: ' + e.message);
            }
        }

        export async function pcSwitchProxy(switchMode = 'hot') {
            return pcSwitchIP(switchMode);
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
                pcPopulateTargets();
                let servers = [];
                const realtimeSnapshots = Object.values(window.kuiRealtimeProxySnapshots || {});
                // Realtime is a fast path only. Keep an HTTP snapshot so a missing proxy
                // socket or an incomplete realtime patch cannot hide persisted tunnel data.
                if (Date.now() - lastPcHttpFetch >= 15000) {
                    const auth = await getPcAuthHeader('GET', '/api/proxy/nodes');
                    const res = await fetch(`/api/proxy/nodes?t=${Date.now()}`, { headers: { 'Authorization': auth } });
                    if (!res.ok) throw new Error(`proxy nodes ${res.status}`);
                    const nodes = await res.json();
                    pcHttpServers = Array.isArray(nodes) ? nodes.map(server => ({
                        ...server,
                        _pc_http_sample_ts: pcSampleTimestamp(server),
                    })) : [];
                    lastPcHttpFetch = Date.now();
                }
                servers = pcHttpServers.slice();
                if (realtimeSnapshots.length) {
                    const byIp = new Map(servers.map(server => [server.ip, server]));
                    realtimeSnapshots.forEach(snapshot => {
                        const previous = byIp.get(snapshot.ip) || {};
                        const realtimeTs = pcSampleTimestamp(snapshot);
                        const httpTs = Number(previous._pc_http_sample_ts || 0);
                        if (realtimeTs > 0 && httpTs > 0 && realtimeTs < httpTs) return;
                        byIp.set(snapshot.ip, pcMergeRealtimeServer(previous, snapshot));
                    });
                    servers = Array.from(byIp.values());
                    // Keep cleared realtime details in the HTTP fallback cache so
                    // reconnects cannot resurrect stale tunnel rows.
                    pcHttpServers = servers.map(server => ({
                        ...server,
                        _pc_http_sample_ts: Number(server._pc_http_sample_ts || 0),
                    }));
                }
                const tbody = document.getElementById('pc-nodes-table');
                const terminal = document.getElementById('pc-terminal-output');
                const purityAttribution = document.getElementById('pc-purity-attribution');
                if (!tbody) return;

                if (!servers || servers.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="6" class="py-12 text-center text-slate-500 flex-col items-center justify-center"><svg class="w-12 h-12 mx-auto text-slate-700 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"></path></svg>未检测到在线母机，请在 VPS 运行纳管命令接入</td></tr>';
                    if (purityAttribution) purityAttribution.style.display = 'none';
                    return;
                }

                const managedServerNames = new Map((window.kuiManagedServers?.() || []).map(server => [server.ip, String(server.name || '').trim()]));
                let hasIpokPurityData = false;
                tbody.innerHTML = servers.map(server => {
                    const details = pcParseTunnelDetails(server.details);
                    if (!hasIpokPurityData && details.some(detail => formatExitPurityMeta(detail)?.hasIpok)) {
                        hasIpokPurityData = true;
                    }
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
                                ${pcTunnelTelemetryBadges(d)}
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
                if (purityAttribution) {
                    purityAttribution.style.display = hasIpokPurityData ? '' : 'none';
                }

                const selectedIp = document.getElementById('slot-target-ip')?.value || '';
                const selectedServer = (selectedIp && selectedIp !== '*' ? servers.find(server => server.ip === selectedIp) : null) || servers[0];
                const selectedDetails = pcParseTunnelDetails(selectedServer?.details);
                const activeNode = selectedDetails.find(d => d.active && d.node_ip) || selectedDetails.find(d => d.node_ip);
                if (activeNode?.node_ip) {
                    const newIp = activeNode.node_ip;
                    if (newIp !== pcCurrentScoreIp) {
                        pcCurrentScoreIp = newIp;
                        const scoreSection = document.getElementById('pc-ip-score-section');
                        if (scoreSection) scoreSection.style.display = 'block';

                        const scoreLink = document.getElementById('pc-ip-score-link');
                        if (scoreLink) {
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
                        }

                        pcLoadNativeIpScore(newIp);
                    }
                } else {
                    pcCurrentScoreIp = '';
                    const scoreSection = document.getElementById('pc-ip-score-section');
                    if (scoreSection) scoreSection.style.display = 'none';
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
            lastPcHttpFetch = 0;
            pcHttpServers = [];
        }

        // Keep the legacy window bridge for manual refresh and custom integrations.
        Object.assign(window, { pcFetchCountries, pcFetchNodes, pcLoadConfig, pcSaveConfig, pcSwitchIP, pcSwitchProxy, pcPopulateTargets });
