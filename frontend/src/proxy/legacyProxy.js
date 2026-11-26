import { formatExitPurityMeta, normalizeIpProfile } from '../utils/egressState.js';
import { formatRegionName, formatRegionWithCity, regionMatchesQuery, resolveRegionCodeFromInput } from '../utils/regionNames.js';

/* ================= Proxy Controller 双活引擎总控 (内联逻辑) ================= */
        let pcInterval = null;
        let pcCurrentScoreIp = null;
        let pcCurrentScoreKey = '';
        let pcScoreRequestSeq = 0;
        let pcProfileRole = 'active';
        let pcProfileView = null;
        const pcProfileFallbackCache = new Map();
        const pcProfileProbeLoading = {
            recheck_purity: false,
            probe_latency: false,
        };

        function pcEscapeHtml(value) {
            return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
        }

        function pcNormalizeCountryInput(value) {
            return String(value ?? '').trim().replace(/\s+/g, '');
        }

        export function normalizePcCountry(value) {
            const raw = String(value ?? '').trim();
            if (!raw) return '';
            return resolveRegionCodeFromInput(raw) || resolveRegionCodeFromInput(pcNormalizeCountryInput(raw));
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
        let pcLoadedSnapshot = null;
        let pcCountryEntries = [];
        let pcCountryFilterQuery = '';
        let pcCountriesExpanded = false;
        let pcLogFilterMode = 'all';
        let pcLogScrollPaused = false;
        let pcLastRawLogs = '';

        function pcNotifyUser(message, tone = 'info') {
            if (!message) return;
            if (typeof window !== 'undefined' && typeof window.kuiShowToast === 'function') {
                window.kuiShowToast(message, tone);
            }
        }

        async function pcCopyText(text, successMessage) {
            const value = String(text || '').trim();
            if (!value) return false;
            try {
                if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
                    await navigator.clipboard.writeText(value);
                    pcNotifyUser(successMessage || '已复制到剪贴板', 'success');
                    return true;
                }
            } catch (err) {
                console.warn('[pc] clipboard write failed:', err);
            }
            pcNotifyUser('复制失败，请手动选中复制', 'error');
            return false;
        }

        function pcReadRawFormSnapshot() {
            const target = document.getElementById('slot-target-ip')?.value || '';
            const country = normalizePcCountry(document.getElementById('slot-cfg-0')?.value || '');
            const port = String(document.getElementById('slot-port')?.value ?? '').trim();
            const listenHost = normalizePcListenHost(document.getElementById('slot-listen-host')?.value || '');
            return { target, country, port, listenHost };
        }

        function pcSyncDirtyIndicator() {
            const badge = document.getElementById('pc-config-dirty-badge');
            const policyMain = document.getElementById('pc-overview-policy');
            const policySub = document.getElementById('pc-overview-policy-sub');
            const current = pcReadRawFormSnapshot();
            const configLoaded = current.target && pcLoadedSnapshot?.target === current.target;
            if (policyMain) {
                policyMain.textContent = configLoaded
                    ? `${formatRegionName(current.country || 'JP')} · :${current.port || '7920'}`
                    : (current.target ? '等待配置同步' : '—');
            }
            if (policySub) {
                let listenerLabel = '';
                if (configLoaded) {
                    listenerLabel = current.listenHost === '*'
                        ? '公网监听 (*)'
                        : (current.listenHost ? `监听 ${current.listenHost}` : '本机/网桥默认');
                }
                policySub.textContent = listenerLabel;
            }
            const dirty = Boolean(
                configLoaded
                && (
                    pcLoadedSnapshot.country !== current.country
                    || pcLoadedSnapshot.port !== current.port
                    || pcLoadedSnapshot.listenHost !== current.listenHost
                )
            );
            if (badge) {
                badge.style.display = dirty ? 'inline-flex' : 'none';
            }
        }

        function pcCaptureLoadedSnapshot() {
            pcLoadedSnapshot = pcReadRawFormSnapshot();
            pcSyncDirtyIndicator();
        }

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
            pcSyncDirtyIndicator();
            if (pcClearInvalidPendingRetry()) pcRenderOverviewFromCache();
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
            pcLoadedSnapshot = null;
            pcSyncDirtyIndicator();
        }


        function pcTargetSelectionChanged() {
            pcTargetSelectionEpoch += 1;
            pcPendingRetry = null;
            pcInvalidateLoadedForm();
            pcMarkFieldsClean();
            pcRenderOverviewFromCache();
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
                alert('❌ 目标地区必须是中文地区名、2 位国家码或 ANY');
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

        function pcPendingSwitchRetry(mode, currentSignature) {
            return pcPendingRetry?.kind === 'switch'
                && pcPendingRetry.formRevision === pcFormUserRevision
                && pcPendingRetry.mode === mode
                && pcPendingRetry.ips.length > 0
                && pcPendingRetry.targets.length > 0
                && (
                    pcPendingRetry.signature === currentSignature
                    || pcPendingRetry.originalSignature === currentSignature
                    || pcLoadedTargetSignature(pcPendingRetry.ips) === currentSignature
                )
                ? pcPendingRetry
                : null;
        }

        function pcSwitchContextForSelection(selectedIp, managedServerMap, mode = 'hot') {
            const selectionTargets = selectedIp === '*'
                ? [...(managedServerMap?.keys?.() || [])]
                : (selectedIp ? [selectedIp] : []);
            const retry = pcPendingSwitchRetry(mode, pcLoadedTargetSignature(selectionTargets));
            return {
                selectionTargets,
                retry,
                targets: retry ? retry.ips.slice() : selectionTargets,
            };
        }

        function pcClearInvalidPendingRetry() {
            if (!pcPendingRetry || pcPendingRetry.kind !== 'switch') return false;
            if (pcPendingRetry.formRevision === pcFormUserRevision) return false;
            pcPendingRetry = null;
            return true;
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
            if (kind === 'switch' && options.allowRetry) {
                const selectedIp = document.getElementById('slot-target-ip')?.value || '';
                const managedServerMap = new Map(pcManagedServers().map(server => [server.ip, server]));
                return pcSwitchContextForSelection(selectedIp, managedServerMap, mode).targets;
            }
            return pcSelectedTargets();
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

        export function formatPcDurationZh(value) {
            const seconds = pcTelemetryNumber(value);
            if (seconds === null) return '';
            const total = Math.floor(seconds);
            if (total < 60) return `${total}秒`;
            const days = Math.floor(total / 86400);
            const hours = Math.floor((total % 86400) / 3600);
            const minutes = Math.floor((total % 3600) / 60);
            const secs = total % 60;
            if (days > 0) return `${days}天${hours}小时`;
            if (hours > 0) return `${hours}小时${minutes}分`;
            return `${minutes}分${secs}秒`;
        }

        export function formatPcBytes(value) {
            const bytes = pcTelemetryNumber(value);
            if (bytes === null) return '';
            if (bytes < 1024) return `${Math.round(bytes)}B`;
            const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
            let amount = bytes / 1024;
            let unit = 0;
            while (amount >= 1024 && unit < units.length - 1) {
                amount /= 1024;
                unit += 1;
            }
            return `${amount >= 100 ? Math.round(amount) : amount.toFixed(1)}${units[unit]}`;
        }

        function pcFormatThroughput(value) {
            const kbps = pcTelemetryNumber(value);
            if (kbps === null) return '';
            if (kbps >= 8000) return `${(kbps / 8000).toFixed(1)} MB/s`;
            if (kbps >= 1000) return `${(kbps / 1000).toFixed(1)} Mbps`;
            return `${Math.round(kbps)} kbps`;
        }

        function pcYesNo(value) {
            if (value === true) return '是';
            if (value === false) return '否';
            return '未知';
        }

        function pcRelativeTime(value, now = Date.now()) {
            const timestamp = pcTimestampMs(value);
            if (!timestamp) return '';
            const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
            if (seconds < 60) return `${seconds} 秒前`;
            if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
            if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
            return `${Math.floor(seconds / 86400)} 天前`;
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
                    badges.push(`<span class="pc-tunnel-badge pc-tunnel-badge-risk inline-flex items-center whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] font-mono ${pcPurityToneClasses(purity.fraudTone)}" title="IPPure 风险分: ${purity.fraudScore}">IPPure ${pcEscapeHtml(purity.fraudLevelLabel)}</span>`);
                }
                if (purity.ipokRisk !== null) {
                    badges.push(`<span class="pc-tunnel-badge pc-tunnel-badge-risk inline-flex items-center whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] font-mono ${pcPurityToneClasses(purity.ipokTone)}" title="IPOK 风险分: ${purity.ipokRisk}">IPOK ${pcEscapeHtml(purity.ipokLevelLabel)}</span>`);
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

        function pcTunnelExitIp(detail) {
            return String(detail?.exit_ip || detail?.node_ip || '').trim();
        }

        function pcDescribeTunnelChannel(detail) {
            const tunnel = detail && typeof detail === 'object' ? detail : null;
            const exitIp = tunnel ? pcTunnelExitIp(tunnel) : '';
            const hasExitIp = Boolean(exitIp);
            const hasReadyFlag = Boolean(tunnel) && typeof tunnel.ready === 'boolean';
            const reported = Boolean(tunnel) && (hasExitIp || hasReadyFlag);
            const explicitNotReady = reported && tunnel.ready !== undefined && tunnel.ready !== true;
            const legacy = reported && hasExitIp && !explicitNotReady
                && (tunnel.ready === undefined || tunnel.ready_omitted === true);
            const ready = reported && typeof tunnel.active === 'boolean' && hasExitIp && !explicitNotReady;
            return {
                detail: tunnel,
                reported,
                hasExitIp,
                usable: ready,
                ready,
                explicitNotReady,
                legacy,
                exitIp,
            };
        }

        function pcResolveTunnelPair(details) {
            const tunnels = pcParseTunnelDetails(details);
            const resolve = active => {
                const candidates = tunnels.filter(detail => detail.active === active);
                const channels = candidates.map(pcDescribeTunnelChannel);
                return channels.find(channel => channel.ready)
                    || channels.find(channel => channel.reported)
                    || pcDescribeTunnelChannel(null);
            };
            const active = resolve(true);
            const standby = resolve(false);
            return {
                tunnels,
                active,
                standby,
                validChannels: [active, standby].filter(channel => channel.reported).length,
            };
        }

        function pcAssessTargetReadiness(targets, servers = [], managedServerMap = new Map()) {
            const byIp = new Map((Array.isArray(servers) ? servers : [])
                .filter(server => server && server.ip)
                .map(server => [server.ip, server]));
            const items = [...new Set((Array.isArray(targets) ? targets : []).filter(Boolean))].map(ip => {
                const server = byIp.get(ip) || null;
                const managed = managedServerMap?.get(ip) || null;
                const pair = pcResolveTunnelPair(server?.details);
                return {
                    ip,
                    server,
                    managed,
                    pair,
                    activeReady: pair.active.ready,
                    standbyReady: pair.standby.ready,
                    activeLegacy: pair.active.legacy,
                    standbyLegacy: pair.standby.legacy,
                };
            });
            const total = items.length;
            const activeReady = items.filter(item => item.activeReady).length;
            const standbyReady = items.filter(item => item.standbyReady).length;
            const bothReady = items.filter(item => item.activeReady && item.standbyReady).length;
            return {
                items,
                total,
                activeReady,
                standbyReady,
                bothReady,
                allActiveReady: total > 0 && activeReady === total,
                allStandbyReady: total > 0 && standbyReady === total,
                hasLegacyStandby: items.some(item => item.standbyLegacy),
            };
        }

        function pcStatusRow(label, value) {
            return `<div class="pc-status-row"><span class="pc-status-label">${pcEscapeHtml(label)}</span><span class="pc-status-value">${value}</span></div>`;
        }

        function pcRenderExitStatusRows(role, detail, reported = false) {
            const container = document.getElementById(`pc-overview-${role === 'active' ? 'exit' : 'standby'}-sub`);
            if (!container) return;
            if (!reported || !detail) {
                const placeholder = role === 'active' ? '质量待上报 · 等待主通道' : '质量待上报 · 等待备用通道预热';
                container.innerHTML = `<span class="pc-status-placeholder">${placeholder}</span>`;
                return;
            }
            const meta = formatExitPurityMeta(detail);
            const asnTitle = meta?.asnOrg ? ` title="${pcEscapeHtml(meta.asnOrg)}"` : '';
            const profile = meta?.ipProfile || null;
            const regionLabel = formatRegionWithCity(
                detail.country || profile?.country_code || '',
                detail.city || profile?.city || '',
                detail.region || profile?.region || '',
            );
            const fraudTitle = meta?.fraudScore !== null && meta?.fraudScore !== undefined
                ? ` title="IPPure 风险分: ${meta.fraudScore}"`
                : '';
            const ipokTitle = meta?.ipokRisk !== null && meta?.ipokRisk !== undefined
                ? ` title="IPOK 风险分: ${meta.ipokRisk}"`
                : '';
            const ttfb = pcTelemetryNumber(detail.ttfb_ms);
            const rows = [
                pcStatusRow('地区', pcEscapeHtml(regionLabel || '—')),
                `<div class="pc-status-row"><span class="pc-status-label">IP 类型</span><span class="pc-status-value"${asnTitle}>${pcEscapeHtml(meta?.typeLabel || '—')}</span></div>`,
                pcStatusRow('运营商', pcEscapeHtml(meta?.asnOrg || '—')),
                `<div class="pc-status-row"><span class="pc-status-label">IPPure</span><span class="pc-status-value"${fraudTitle}>${pcEscapeHtml(meta?.fraudScore !== null && meta?.fraudScore !== undefined ? meta.fraudLevelLabel : '—')}</span></div>`,
            ];
            rows.push(`<div class="pc-status-row"><span class="pc-status-label"><a href="https://ipok.io" target="_blank" rel="noopener noreferrer">IPOK</a></span><span class="pc-status-value"${ipokTitle}>${pcEscapeHtml(meta?.ipokRisk !== null && meta?.ipokRisk !== undefined ? meta.ipokLevelLabel : '—')}</span></div>`);
            rows.push(pcStatusRow('实测延迟', pcEscapeHtml(ttfb === null ? '—' : `${Math.round(ttfb)} ms`)));
            container.innerHTML = rows.join('');
        }

        function pcRenderChannelDetailRows(role, detail, reported = false) {
            const detailsEl = document.getElementById(`pc-${role}-details`);
            const container = document.getElementById(`pc-${role}-detail-rows`);
            if (!detailsEl) return;
            detailsEl.hidden = !reported || !detail;
            if (!container) return;
            if (!reported || !detail) {
                container.innerHTML = '';
                return;
            }
            const rows = [
                pcStatusRow('隧道', pcEscapeHtml(detail.tunnel || '—')),
                pcStatusRow('端口', pcEscapeHtml(detail.port || '—')),
            ];
            [
                ['首包', pcTelemetryNumber(detail.ttfb_ms), value => `${Math.round(value)}ms`],
                ['吞吐', formatPcSpeed(detail.speed_kbps), value => value],
                ['已连', pcTelemetryNumber(detail.connected_time), value => value > 0 ? formatPcDuration(value) : ''],
            ].forEach(([label, value, format]) => {
                const text = value === null ? '' : format(value);
                rows.push(pcStatusRow(label, pcEscapeHtml(text || '—')));
            });
            container.innerHTML = rows.join('');
        }

        function pcTimestampMs(value) {
            const timestamp = Number(value);
            if (!Number.isFinite(timestamp) || timestamp <= 0) return 0;
            return timestamp < 1e12 ? timestamp * 1000 : timestamp;
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
                const timestamp = pcTimestampMs(value);
                if (timestamp > 0) return timestamp;
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
            const preferred = typeof window !== 'undefined' ? String(window.pcPreferredTargetIp || '').trim() : '';
            const previous = (preferred && targets.includes(preferred)) ? preferred : select.value;
            if (preferred && targets.includes(preferred)) {
                window.pcPreferredTargetIp = '';
            }
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
                    pcSyncDirtyIndicator();
                    pcRenderOverviewFromCache();
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
            pcCountryEntries = Array.isArray(entries) ? entries.slice() : [];
            const query = String(pcCountryFilterQuery || '').trim();
            const selectedCode = normalizePcCountry(document.getElementById('slot-cfg-0')?.value);
            const toggleBtn = document.getElementById('pc-country-toggle');
            const countEl = document.getElementById('pc-country-count');
            const filtered = query
                ? pcCountryEntries.filter(item => regionMatchesQuery(item.code, query))
                : pcCountryEntries;
            const COLLAPSE_LIMIT = 16;
            const shouldCollapse = Boolean(toggleBtn && !query && !pcCountriesExpanded && filtered.length > COLLAPSE_LIMIT);
            let visibleEntries = filtered;
            if (shouldCollapse) {
                visibleEntries = filtered.slice(0, COLLAPSE_LIMIT);
                if (selectedCode && selectedCode !== 'ANY' && !visibleEntries.some(item => item.code === selectedCode)) {
                    const activeItem = filtered.find(item => item.code === selectedCode);
                    if (activeItem) visibleEntries.push(activeItem);
                }
            }
            if (toggleBtn) {
                const showToggle = !query && filtered.length > COLLAPSE_LIMIT;
                toggleBtn.style.display = showToggle ? 'inline-flex' : 'none';
                toggleBtn.textContent = pcCountriesExpanded ? '收起地区' : `展开全部 (${filtered.length})`;
            }
            if (countEl) {
                countEl.textContent = query ? `匹配 ${filtered.length} / ${pcCountryEntries.length}` : `${pcCountryEntries.length} 个地区`;
            }
            const anyChip = '<button type="button" data-country-code="ANY" data-country-name="全球自动" title="选择全球自动，自动优选全球最快节点" class="pc-country-chip pc-country-chip-any">全球自动<span class="ml-1 text-indigo-300">自动优选</span></button>';
            const unavailable = pcCountryEntries.some(item => item.nodes === null)
                ? '<span class="w-full text-sm text-rose-500">节点数量读取失败，请稍后刷新</span>' : '';
            const emptyMatch = query && visibleEntries.length === 0
                ? '<span class="pc-country-empty">未找到匹配地区，可直接输入中文地区名、2 位代码或选择全球自动</span>'
                : '';
            container.innerHTML = unavailable + anyChip + visibleEntries.map(item => {
                const code = pcEscapeHtml(item.code);
                const name = pcEscapeHtml(formatRegionName(item.code));
                const count = item.nodes === null ? '—' : item.nodes;
                const countClass = item.nodes === null ? 'text-slate-500' : (item.nodes > 0 ? 'text-emerald-400' : 'text-rose-400');
                return `<button type="button" data-country-code="${code}" data-country-name="${name}" title="选择 ${name}（${code}），候选节点 ${count} 个" class="pc-country-chip">${name}<span class="ml-1 ${countClass}">${count}</span></button>`;
            }).join('') + emptyMatch;
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
                input.addEventListener('input', () => pcSyncCountrySelection());
                input.addEventListener('change', () => {
                    const normalized = normalizePcCountry(input.value);
                    if (normalized && input.value !== normalized) input.value = normalized;
                    pcSyncCountrySelection();
                });
                input.dataset.pcCountrySync = '1';
            }
            pcSyncCountrySelection();
        }

        export function pcSetCountryFilter(query = '') {
            pcCountryFilterQuery = String(query || '');
            const container = document.getElementById('countries-list');
            if (container) pcRenderCountryShortcuts(container, pcCountryEntries);
        }

        export function pcToggleCountriesExpanded() {
            pcCountriesExpanded = !pcCountriesExpanded;
            const container = document.getElementById('countries-list');
            if (container) pcRenderCountryShortcuts(container, pcCountryEntries);
            return pcCountriesExpanded;
        }

        export function pcSelectTargetIp(ip) {
            const select = document.getElementById('slot-target-ip');
            const nextIp = String(ip || '').trim();
            if (!select || !nextIp || select.value === nextIp) return false;
            const hasOption = Array.from(select.options || []).some(opt => opt.value === nextIp);
            if (!hasOption) return false;
            select.value = nextIp;
            pcInvalidateLoadedConfig();
            pcRenderOverviewFromCache();
            pcLoadConfig();
            pcFetchNodes();
            return true;
        }

        function pcRenderLogs(rawLogs) {
            pcLastRawLogs = String(rawLogs || '');
            const terminal = document.getElementById('pc-terminal-output');
            if (!terminal) return;
            if (!pcLastRawLogs) {
                terminal.textContent = '目标 VPS 暂无日志上报。';
                return;
            }
            const isAtBottom = terminal.scrollHeight - terminal.scrollTop <= terminal.clientHeight + 30;
            const sourceLines = pcLastRawLogs.split('\n');
            const lines = pcLogFilterMode === 'warn'
                ? sourceLines.filter(line => /\[[-!]\]|ERROR|WARN|FAIL|失联|失败|异常|超时/i.test(line))
                : sourceLines;
            if (pcLogFilterMode === 'warn' && lines.length === 0) {
                terminal.innerHTML = '<div class="pc-log-empty">当前日志中没有告警或错误记录。</div>';
                return;
            }
            const logHTML = lines.join('\n')
                .replace(/</g, '&lt;').replace(/>/g, '&gt;')
                .replace(/\[\*\]/g, '<span class="text-indigo-400 font-bold">[*]</span>')
                .replace(/\[\+\]/g, '<span class="text-emerald-400 font-bold">[+]</span>')
                .replace(/\[\-\]/g, '<span class="text-rose-400 font-bold">[-]</span>')
                .replace(/\[\!\]/g, '<span class="text-amber-400 font-bold">[!]</span>');
            terminal.innerHTML = '<pre class="whitespace-pre-wrap break-all">' + logHTML + '</pre>';
            if (isAtBottom && !pcLogScrollPaused) {
                terminal.scrollTop = terminal.scrollHeight;
            }
        }

        export function pcSetLogFilter(mode = 'all') {
            pcLogFilterMode = mode === 'warn' ? 'warn' : 'all';
            pcRenderLogs(pcLastRawLogs);
            return pcLogFilterMode;
        }

        export function pcToggleLogPause() {
            pcLogScrollPaused = !pcLogScrollPaused;
            if (!pcLogScrollPaused) {
                const terminal = document.getElementById('pc-terminal-output');
                if (terminal) terminal.scrollTop = terminal.scrollHeight;
            }
            return pcLogScrollPaused;
        }

        export async function pcCopyLogs() {
            if (!pcLastRawLogs) {
                pcNotifyUser('当前暂无可复制的运行日志', 'info');
                return false;
            }
            return pcCopyText(pcLastRawLogs, '运行日志已复制到剪贴板');
        }

        function pcRenderOverviewCard(role, { detail, ipText = '—', statusText = '', tone = 'neutral' }) {
            const isActive = role === 'active';
            const channel = pcDescribeTunnelChannel(detail);
            const exitIp = channel.ready ? channel.exitIp : '';
            const ipEl = document.getElementById(isActive ? 'pc-overview-exit' : 'pc-overview-standby');
            const statusEl = document.getElementById(`pc-overview-${role}-status`);
            const copyEl = document.getElementById(`pc-${role}-copy`);
            if (ipEl) {
                ipEl.textContent = exitIp || ipText;
                if (exitIp) {
                    ipEl.dataset.copyIp = exitIp;
                } else {
                    delete ipEl.dataset.copyIp;
                    ipEl.removeAttribute?.('data-copy-ip');
                }
            }
            if (copyEl) copyEl.hidden = !exitIp;
            pcRenderExitStatusRows(role, detail, Boolean(detail));
            pcRenderChannelDetailRows(role, detail, Boolean(detail));
            if (statusEl) {
                if (statusEl.textContent !== statusText) statusEl.textContent = statusText;
                statusEl.dataset.tone = tone;
            }
        }

        function pcNodeOverviewEntries(servers, managedServerMap) {
            const entries = new Map();
            for (const managed of managedServerMap?.values?.() || []) {
                if (!managed?.ip) continue;
                entries.set(managed.ip, { ip: managed.ip, managed, server: null });
            }
            for (const server of Array.isArray(servers) ? servers : []) {
                if (!server?.ip) continue;
                const previous = entries.get(server.ip) || { ip: server.ip, managed: null, server: null };
                entries.set(server.ip, { ...previous, server });
            }
            return [...entries.values()];
        }

        function pcNodeOverviewStatus(server) {
            if (!server) return { label: '离线', tone: 'offline' };
            const lastSeen = pcSampleTimestamp(server);
            if (lastSeen && Date.now() - lastSeen > 10 * 60 * 1000) {
                return { label: '离线', tone: 'offline' };
            }
            const pair = pcResolveTunnelPair(server.details);
            if (pair.active.ready) return { label: '在线', tone: 'online' };
            if (pair.validChannels > 0 || server.details) return { label: '拨号中', tone: 'dialing' };
            return { label: '在线', tone: 'online' };
        }

        function pcNodeOverviewCard(entry, selectedIp) {
            const server = entry.server;
            const managed = entry.managed;
            const pair = pcResolveTunnelPair(server?.details);
            const active = pair.active;
            const detail = active.detail || {};
            const meta = formatExitPurityMeta(detail);
            const profile = meta?.ipProfile || null;
            const status = pcNodeOverviewStatus(server);
            const name = managed?.name || server?.name || entry.ip;
            const exitIp = active.exitIp || '';
            const country = formatRegionName(detail.country || profile?.country_code || '');
            const connected = formatPcDurationZh(detail.connected_time);
            const readyCount = (active.ready ? 1 : 0) + (pair.standby.ready ? 1 : 0);
            const activeConns = pcTelemetryNumber(detail.active_conns);
            const maxConns = pcTelemetryNumber(detail.max_conns);
            const connections = activeConns === null && maxConns === null
                ? '--'
                : `${activeConns === null ? '--' : Math.round(activeConns)} / ${maxConns === null ? '--' : Math.round(maxConns)}`;
            const up = formatPcBytes(detail.bytes_up);
            const down = formatPcBytes(detail.bytes_down);
            const traffic = up || down
                ? [up ? `↑${up}` : '', down ? `↓${down}` : ''].filter(Boolean).join(' · ')
                : '--';
            const purityLabel = meta
                ? `${meta.verdictLabel}${meta.typeLabel ? ` · ${meta.typeLabel}` : ''}`
                : '待检测';
            const ttfb = pcTelemetryNumber(detail.ttfb_ms);
            const port = pcTelemetryNumber(detail.port) ?? 7920;
            const selected = selectedIp === entry.ip;
            const selectedClass = selected ? ' is-selected' : '';
            const currentAttr = selected ? ' aria-current="true"' : '';
            const metaParts = [
                country || '未知地区',
                connected ? `已连 ${connected}` : '',
                `${readyCount}/2 通道`,
            ].filter(Boolean);
            return `<article class="pc-node-card${selectedClass}" data-node-ip="${pcEscapeHtml(entry.ip)}" role="button" tabindex="0" aria-label="切换到节点 ${pcEscapeHtml(name)}"${currentAttr}>
                <div class="pc-node-card-head">
                    <strong>${pcEscapeHtml(name)}</strong>
                    <span class="pc-node-state is-${status.tone}">${status.label}</span>
                </div>
                <div class="pc-node-card-exit">
                    <span>主出口</span>
                    <strong class="pc-font-mono">${pcEscapeHtml(exitIp || '—')}</strong>
                </div>
                <div class="pc-node-card-host">宿主机 <span class="pc-font-mono">${pcEscapeHtml(entry.ip)}</span></div>
                <div class="pc-node-card-meta">${metaParts.map(part => `<span>${pcEscapeHtml(part)}</span>`).join('')}</div>
                <div class="pc-node-card-stats">
                    <span>${pcEscapeHtml(connections)} 连接</span>
                    <span>${pcEscapeHtml(traffic)}</span>
                    <span class="pc-node-port-pill">端口 ${pcEscapeHtml(port)}</span>
                </div>
                <div class="pc-node-card-badges">
                    <span class="pc-purity-pill" data-tone="${pcEscapeHtml(meta?.verdictTone || 'neutral')}">${pcEscapeHtml(purityLabel)}</span>
                    <span class="pc-latency-pill">${pcEscapeHtml(ttfb === null ? '延迟待测' : `${Math.round(ttfb)} ms`)}</span>
                </div>
            </article>`;
        }

        function pcRenderNodeOverview(servers, selectedIp, managedServerMap) {
            const container = document.getElementById('pc-node-overview-grid');
            const countEl = document.getElementById('pc-node-overview-count');
            const batchBtn = document.getElementById('pc-batch-mode-btn');
            const entries = pcNodeOverviewEntries(servers, managedServerMap);
            if (batchBtn) {
                const batch = selectedIp === '*';
                batchBtn.classList?.toggle('is-active', batch);
                batchBtn.setAttribute?.('aria-pressed', batch ? 'true' : 'false');
                const label = batchBtn.querySelector?.('span');
                const text = batch ? '退出批量模式' : '全部节点批量模式';
                if (label) label.textContent = text;
                else if (batchBtn.textContent !== text) batchBtn.textContent = text;
            }
            if (countEl) countEl.textContent = `${entries.length} 个节点`;
            if (!container) return;
            if (!entries.length) {
                container.innerHTML = '<div class="pc-node-overview-empty">暂无已接入节点，请先在服务器页面接入 VPS。</div>';
                return;
            }
            container.innerHTML = entries.map(entry => pcNodeOverviewCard(entry, selectedIp)).join('');
            if (container.dataset.pcNodeOverviewBound !== '1') {
                const activate = event => {
                    if (event?.type === 'keydown' && !['Enter', ' '].includes(event.key)) return;
                    const target = event?.target;
                    const card = target?.closest?.('[data-node-ip]')
                        || (target?.dataset?.nodeIp ? target : null);
                    const ip = String(card?.dataset?.nodeIp || '').trim();
                    if (!ip) return;
                    event.preventDefault?.();
                    pcSelectTargetIp(ip);
                };
                container.addEventListener('click', activate);
                container.addEventListener('keydown', activate);
                container.dataset.pcNodeOverviewBound = '1';
            }
        }

        export function pcToggleBatchMode() {
            const select = document.getElementById('slot-target-ip');
            if (!select) return false;
            pcPopulateTargets();
            const targets = pcManagedServers().map(server => server.ip).filter(Boolean);
            if (!targets.length) {
                pcNotifyUser('暂无已接入节点，无法进入批量模式', 'warning');
                return false;
            }
            const entering = select.value !== '*';
            if (entering && targets.length < 2) {
                pcNotifyUser('至少需要 2 台节点才能使用批量模式', 'info');
                return false;
            }
            const nextValue = entering ? '*' : targets[0];
            if (!Array.from(select.options || []).some(option => option.value === nextValue)) {
                pcNotifyUser('当前节点列表不支持批量模式', 'warning');
                return false;
            }
            select.value = nextValue;
            pcInvalidateLoadedConfig();
            pcRenderOverviewFromCache();
            pcLoadConfig();
            pcFetchNodes();
            return entering;
        }

        function pcSetHotSwitchButton(hotBtn, enabled, title, label = '切换至备用') {
            if (!hotBtn) return;
            hotBtn.disabled = !enabled;
            hotBtn.classList?.toggle('is-standby-missing', !enabled);
            hotBtn.title = title;
            const labelEl = hotBtn.querySelector?.('span') || hotBtn;
            if (labelEl && label && labelEl.textContent !== label) {
                labelEl.textContent = label;
            }
        }

        function pcHotSwitchButtonLabel(readiness, retry) {
            return retry ? `重试失败目标 (${readiness.total} 台)` : '切换至备用';
        }

        function pcHotSwitchButtonTitle(readiness, retry, fallback) {
            const prefix = retry ? `重试 ${readiness.total} 台失败目标` : '';
            if (!readiness.allStandbyReady) {
                return prefix ? `${prefix} · 备用通道未就绪` : fallback;
            }
            return prefix ? `${prefix} · 切换至备用出口` : fallback;
        }

        function pcOverviewTarget(servers, selectedIp, managedServerMap) {
            if (!selectedIp || selectedIp === '*') return null;
            const server = (servers || []).find(item => item?.ip === selectedIp) || null;
            const managed = managedServerMap?.get(selectedIp) || null;
            if (!server && !managed) return null;
            return {
                ip: selectedIp,
                server,
                managed,
                name: server?.name || managed?.name || selectedIp,
            };
        }

        function pcOverviewPolicyText(target) {
            const mode = target?.managed?.egress_applied_mode || '';
            if (mode === 'residential') {
                return `住宅（${target.managed.proxy_mode === 'selective' ? '局部' : '全局'}）`;
            }
            return mode ? '节点策略未启用住宅' : '按代理上报统计';
        }

        function pcChannelStatusLabel(channel, label, pair) {
            if (channel.ready) return `${label}通道就绪${channel.legacy ? '（旧版）' : ''}`;
            if (pair.validChannels === 0) return '通道未上报';
            return `${label}通道未就绪`;
        }

        function pcChannelSummaryLabel(channel, label, pair) {
            if (channel.ready) return `${label}通道就绪`;
            if (pair.validChannels === 0) return `${label}通道未上报`;
            return `${label}通道未就绪`;
        }

        function pcRenderTargetStatusRows(target, emptyText = '等待节点同步', lastSeen = 0) {
            const container = document.getElementById('pc-overview-target-sub');
            if (!container) return;
            if (!target) {
                container.innerHTML = `<span class="pc-status-placeholder">${pcEscapeHtml(emptyText)}</span>`;
                return;
            }
            if (target.batch) {
                container.innerHTML = [
                    pcStatusRow('范围', pcEscapeHtml(target.scope || '全部纳管 VPS')),
                    pcStatusRow('目标', `${pcEscapeHtml(String(target.total || 0))} 台`),
                    pcStatusRow('节点策略', '批量按各节点上报统计'),
                ].join('');
                return;
            }
            const heartbeat = lastSeen
                ? `${Math.max(0, Math.floor((Date.now() - lastSeen) / 1000))}s 前`
                : '等待通道上报';
            container.innerHTML = [
                pcStatusRow('IP', pcEscapeHtml(target.ip || '—')),
                pcStatusRow('心跳', pcEscapeHtml(heartbeat)),
                pcStatusRow('节点策略', pcEscapeHtml(pcOverviewPolicyText(target))),
            ].join('');
        }

        function pcRenderTargetBadge(servers, selectedIp, managedServerMap) {
            const badge = document.getElementById('pc-detail-target-badge');
            if (!badge) return;
            if (selectedIp === '*') {
                badge.textContent = `全部节点 (${managedServerMap?.size || 0})`;
                badge.dataset.tone = 'batch';
                return;
            }
            const target = pcOverviewTarget(servers, selectedIp, managedServerMap);
            badge.textContent = target?.name || '等待节点同步';
            badge.dataset.tone = target ? 'node' : 'neutral';
        }

        function pcRenderTargetMetrics(pair) {
            const connectionsEl = document.getElementById('pc-overview-connections');
            const trafficEl = document.getElementById('pc-overview-traffic');
            const detail = pair?.active?.detail || {};
            const activeConns = pcTelemetryNumber(detail.active_conns);
            const maxConns = pcTelemetryNumber(detail.max_conns);
            if (connectionsEl) {
                connectionsEl.textContent = activeConns === null && maxConns === null
                    ? '--'
                    : `${activeConns === null ? '--' : Math.round(activeConns)} / ${maxConns === null ? '--' : Math.round(maxConns)}`;
            }
            const up = formatPcBytes(detail.bytes_up);
            const down = formatPcBytes(detail.bytes_down);
            if (trafficEl) {
                trafficEl.textContent = up || down
                    ? [up ? `↑${up}` : '', down ? `↓${down}` : ''].filter(Boolean).join(' · ')
                    : '--';
            }
        }

        function pcRenderNoOnlineMachines() {
            const hotBtn = document.getElementById('pc-hot-switch-btn');
            const targetEl = document.getElementById('pc-overview-target');
            const channelsEl = document.getElementById('pc-overview-channels');
            if (targetEl) targetEl.textContent = '未检测到母机';
            pcRenderTargetStatusRows(null, '请先接入 VPS 并安装住宅代理');
            if (channelsEl) channelsEl.textContent = '0 / 0 就绪';
            const channelsSub = document.getElementById('pc-overview-channels-sub');
            if (channelsSub) channelsSub.textContent = '等待母机上报主备通道';
            pcRenderTargetMetrics(null);
            for (const role of ['active', 'standby']) {
                pcRenderOverviewCard(role, {
                    ipText: '未检测到母机',
                    statusText: '未检测到母机',
                    tone: 'neutral',
                });
            }
            channelsEl?.classList?.remove('is-good');
            channelsEl?.classList?.add('is-muted');
            pcSetHotSwitchButton(hotBtn, false, '未检测到母机，无法热切换');
            pcHideProfileSection();
        }

        function pcRenderOverview(servers, selectedIp, managedServerMap) {
            const targetEl = document.getElementById('pc-overview-target');
            const channelsEl = document.getElementById('pc-overview-channels');
            const channelsSub = document.getElementById('pc-overview-channels-sub');
            const hotBtn = document.getElementById('pc-hot-switch-btn');
            pcRenderNodeOverview(servers, selectedIp, managedServerMap);
            pcRenderTargetBadge(servers, selectedIp, managedServerMap);

            if (!servers.length && !managedServerMap.size) {
                pcRenderNoOnlineMachines();
                pcSyncDirtyIndicator();
                return;
            }

            if (selectedIp === '*') {
                const targets = [...(managedServerMap?.keys?.() || [])];
                const readiness = pcAssessTargetReadiness(targets, servers, managedServerMap);
                const switchContext = pcSwitchContextForSelection(selectedIp, managedServerMap, 'hot');
                const switchReadiness = pcAssessTargetReadiness(switchContext.targets, servers, managedServerMap);
                const total = readiness.total;
                for (const [role, label] of [['active', '主'], ['standby', '备用']]) {
                    const count = role === 'active' ? readiness.activeReady : readiness.standbyReady;
                    pcRenderOverviewCard(role, {
                        ipText: '批量目标',
                        statusText: `${count} / ${total} ${label}通道就绪`,
                        tone: total > 0 && count === total ? 'ready' : 'neutral',
                    });
                    const subEl = document.getElementById(`pc-overview-${role === 'active' ? 'exit' : 'standby'}-sub`);
                    if (subEl) {
                        subEl.innerHTML = `<span class="pc-status-placeholder">${role === 'active'
                            ? `共 ${total} 台 · ${readiness.activeReady} 台主通道就绪`
                            : `共 ${total} 台 · ${readiness.standbyReady} 台备用就绪`}</span>`;
                    }
                }
                if (targetEl) targetEl.textContent = `全部 VPS (${total} 台)`;
                pcRenderTargetStatusRows({
                    scope: '全部纳管 VPS',
                    total,
                    batch: true,
                }, '批量下发策略与切换指令');
                pcRenderTargetMetrics(null);
                if (channelsEl) channelsEl.textContent = `${readiness.bothReady} / ${total} 双通道就绪`;
                if (channelsSub) channelsSub.textContent = `主通道 ${readiness.activeReady}/${total} · 备用通道 ${readiness.standbyReady}/${total}`;
                pcSetHotSwitchButton(hotBtn, switchReadiness.allStandbyReady,
                    pcHotSwitchButtonTitle(switchReadiness, switchContext.retry,
                        switchReadiness.allStandbyReady ? '切换各 VPS 至备用出口' : '部分 VPS 的备用通道未就绪'),
                    pcHotSwitchButtonLabel(switchReadiness, switchContext.retry));
                channelsEl?.classList?.toggle('is-good', readiness.total > 0 && readiness.bothReady === total);
                channelsEl?.classList?.toggle('is-muted', readiness.bothReady === 0);
            } else {
                const target = pcOverviewTarget(servers, selectedIp, managedServerMap);
                const pair = pcResolveTunnelPair(target?.server?.details);
                const switchContext = pcSwitchContextForSelection(selectedIp, managedServerMap, 'hot');
                const switchReadiness = pcAssessTargetReadiness(switchContext.targets, servers, managedServerMap);
                let readyCount = 0;
                for (const [role, label, channel] of [['active', '主', pair.active], ['standby', '备用', pair.standby]]) {
                    if (channel.ready) readyCount++;
                    const detail = channel.reported ? channel.detail : null;
                    pcRenderOverviewCard(role, {
                        detail,
                        ipText: `${label}通道未就绪`,
                        statusText: !target ? '无目标' : pcChannelStatusLabel(channel, label, pair),
                        tone: !target ? 'neutral' : channel.ready ? 'ready' : 'wait',
                    });
                }
                const lastSeen = pcSampleTimestamp(target?.server);
                if (targetEl) targetEl.textContent = target?.name || '暂无目标 VPS';
                pcRenderTargetStatusRows(target, target ? '' : '请先接入 VPS', lastSeen);
                if (channelsEl) channelsEl.textContent = `${readyCount} / 2 就绪`;
                if (channelsSub) channelsSub.textContent = [pcChannelSummaryLabel(pair.active, '主', pair), pcChannelSummaryLabel(pair.standby, '备用', pair)].join(' · ');
                pcRenderTargetMetrics(pair);
                const canSwitch = Boolean(target) && switchReadiness.allStandbyReady;
                pcSetHotSwitchButton(hotBtn, canSwitch,
                    pcHotSwitchButtonTitle(switchReadiness, switchContext.retry,
                        canSwitch ? '切换至备用出口' : '备用通道未就绪'),
                    pcHotSwitchButtonLabel(switchReadiness, switchContext.retry));
                channelsEl?.classList?.toggle('is-good', readyCount === 2);
                channelsEl?.classList?.toggle('is-muted', readyCount === 0);
            }
            pcSyncDirtyIndicator();
        }

        function pcRenderOverviewFromCache() {
            const selectedIp = document.getElementById('slot-target-ip')?.value || '';
            const managedServerMap = new Map(pcManagedServers().map(server => [server.ip, server]));
            pcRenderOverview(pcNodeServers, selectedIp, managedServerMap);
            pcRenderSelectedDiagnostics(pcNodeServers.find(server => server.ip === selectedIp));
            return pcNodeStateSynced;
        }

        function pcRenderSelectedDiagnostics(server) {
            const { active, standby } = pcResolveTunnelPair(server?.details);
            pcRenderLogs(server?.logs || '');
            const selectedIp = document.getElementById('slot-target-ip')?.value || '';
            pcUpdateProfileRoleButtons({ active, standby });
            if (selectedIp === '*') {
                pcHideProfileSection();
                return;
            }
            const channel = pcProfileRole === 'standby' ? standby : active;
            const exitIp = channel.reported ? channel.exitIp : '';
            const section = document.getElementById('pc-ip-score-section');
            if (!exitIp) {
                pcHideProfileSection();
                return;
            }
            if (section) section.style.display = 'block';
            pcSyncProfileLink();
            const detail = channel.detail || {};
            const profile = normalizeIpProfile(detail.ip_profile);
            const profileSignature = profile
                ? `${profile.checked_at || ''}:${profile.source || ''}:${profile.purity_label || ''}:${profile.ip_type || ''}:${profile.native_type || ''}`
                : 'none';
            const scoreSignature = `${detail.fraud_score ?? ''}:${detail.ipok_risk ?? ''}:${detail.ttfb_ms ?? ''}:${detail.speed_kbps ?? ''}:${detail.latency_checked_at ?? ''}`;
            const cacheKey = `${selectedIp}|${pcProfileRole}|${exitIp}|${profileSignature}|${scoreSignature}`;
            if (cacheKey === pcCurrentScoreKey) return;
            pcCurrentScoreKey = cacheKey;
            pcCurrentScoreIp = exitIp;
            const requestSeq = ++pcScoreRequestSeq;
            if (profile) {
                pcProfileView = {
                    serverIp: selectedIp,
                    role: pcProfileRole,
                    exitIp,
                    detail,
                    profile,
                    source: 'vps',
                };
                pcRenderIpProfileSection(pcProfileView);
                return;
            }
            const fallbackKey = `${exitIp}|${pcProfileRole}`;
            const cached = pcProfileFallbackCache.get(fallbackKey);
            if (cached && Date.now() - cached.at < 5 * 60 * 1000) {
                pcProfileView = {
                    serverIp: selectedIp,
                    role: pcProfileRole,
                    exitIp,
                    detail: { ...detail, ...cached.detail },
                    profile: cached.profile,
                    source: 'fallback',
                };
                pcRenderIpProfileSection(pcProfileView);
                return;
            }
            pcProfileView = null;
            pcRenderProfileLoading(exitIp, pcProfileRole);
            pcLoadIpProfile(exitIp, requestSeq, pcProfileRole, selectedIp, { baseDetail: detail });
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
                pcCaptureLoadedSnapshot();
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
                pcCaptureLoadedSnapshot();
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
                    pcRenderOverviewFromCache();
                    alert(`⚠️ 下发完成：成功 ${succeeded.length} 台，失败 ${failed.length} 台\n${failureText}`);
                    return;
                }
                if (batchSeq === pcWriteEpoch) {
                    pcPendingRetry = null;
                    pcRenderOverviewFromCache();
                }
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
                if (pcClearInvalidPendingRetry()) pcRenderOverviewFromCache();
                pcPopulateTargets();
                const selectedIp = document.getElementById('slot-target-ip')?.value || '';
                const managedServerMap = new Map(pcManagedServers().map(server => [server.ip, server]));
                const switchContext = pcSwitchContextForSelection(selectedIp, managedServerMap, mode);
                const retryState = switchContext.retry;
                const targets = switchContext.targets;
                if (!targets.length) throw new Error('暂无已接入 VPS');
                if (!pcRequireLoadedForm()) return;
                if (!pcRequireIdleWrites(targets)) return;
                if (mode === 'hot') {
                    if (!pcNodeStateSynced) {
                        pcNotifyUser('节点状态尚未同步，已取消热切换，请稍后重试', 'warning');
                        return;
                    } else {
                        const readiness = pcAssessTargetReadiness(targets, pcNodeServers, managedServerMap);
                        const missingStandby = readiness.items
                            .filter(item => !item.standbyReady)
                            .map(item => item.ip);
                        if (missingStandby.length) {
                            const retryHint = retryState ? `重试 ${targets.length} 台失败目标，` : '';
                            pcNotifyUser(`${retryHint}备用通道未就绪：${missingStandby.join('、')}，已取消热切换`, 'warning');
                            pcRenderOverviewFromCache();
                            return;
                        }
                        if (readiness.hasLegacyStandby) {
                            const confirmed = typeof globalThis.confirm === 'function'
                                ? globalThis.confirm('检测到旧版 Agent 的备用通道：热切可能触发回退重拨，现有连接可能中断。是否继续？')
                                : true;
                            if (!confirmed) return;
                        }
                    }
                }
                if (mode === 'full') {
                    const confirmed = typeof globalThis.confirm === 'function'
                        ? globalThis.confirm(`即将对 ${targets.length} 台 VPS 执行全量重拨：现有连接可能中断，新连接将使用新出口。是否继续？`)
                        : true;
                    if (!confirmed) return;
                }
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
                    pcRenderOverviewFromCache();
                    alert('❌ 下发失败: ' + failed.map(item => `${item.ip}: ${item.result.reason?.message || item.result.reason}`).join('\n'));
                    return;
                }
                const actionLabel = mode === 'full' ? '全量重拨' : '热切换';
                const retryFormInvalid = retryState?.kind === 'switch'
                    && retryState.formRevision !== pcFormUserRevision;
                if (retryFormInvalid) {
                    pcPendingRetry = null;
                    pcRenderOverviewFromCache();
                }
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
                    pcRenderOverviewFromCache();
                    const retryHint = pcPendingRetry ? `\n可重试 ${failed.length} 台失败目标` : '';
                    alert(`⚠️ ${actionLabel}完成：成功 ${succeeded.length} 台，失败 ${failed.length} 台\n${failed.map(item => `${item.ip}: ${item.result.reason?.message || item.result.reason}`).join('\n')}${retryHint}`);
                    return;
                }
                if (batchSeq === pcWriteEpoch) {
                    pcPendingRetry = null;
                    pcRenderOverviewFromCache();
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

        export function pcCopyOverviewExit(role) {
            const element = document.getElementById(role === 'standby' ? 'pc-overview-standby' : 'pc-overview-exit');
            const ip = String(element?.dataset?.copyIp || '').trim();
            if (!ip) return false;
            return pcCopyText(ip, `已复制${role === 'standby' ? '备用' : '主'}出口 IP: ${ip}`);
        }

        function pcUpdateProfileRoleButtons(pair) {
            for (const role of ['active', 'standby']) {
                const button = document.getElementById(`pc-profile-role-${role}`);
                if (!button) continue;
                const channel = role === 'active' ? pair?.active : pair?.standby;
                const exitIp = channel?.reported ? channel.exitIp : '';
                button.classList?.toggle('is-active', pcProfileRole === role);
                button.setAttribute?.('aria-pressed', pcProfileRole === role ? 'true' : 'false');
                button.disabled = !exitIp;
                button.dataset.profileIp = exitIp || '';
                button.title = exitIp
                    ? `查看${role === 'active' ? '主' : '备用'}出口 ${exitIp} 的 IP 详情`
                    : `${role === 'active' ? '主' : '备用'}出口尚未就绪`;
                const label = button.querySelector?.('span');
                if (label) label.textContent = exitIp || '未就绪';
            }
        }

        function pcSyncProfileLink() {
            const link = document.getElementById('pc-ip-score-link');
            if (link) {
                link.href = 'https://ipok.io';
                link.setAttribute?.('href', 'https://ipok.io');
                link.onclick = null;
            }
        }

        function pcHideProfileSection() {
            pcScoreRequestSeq += 1;
            const section = document.getElementById('pc-ip-score-section');
            if (section) section.style.display = 'none';
            const container = document.getElementById('pc-native-score-container');
            if (container) container.innerHTML = '';
            pcSyncProfileLink();
            pcCurrentScoreIp = null;
            pcCurrentScoreKey = '';
            pcProfileView = null;
        }

        function pcProfileSourceLabel(source) {
            const text = String(source || '').toLowerCase();
            if (!text) return '';
            if (text.includes('ippure') && text.includes('ipok')) return 'ipok.io · IPPure';
            if (text.includes('ippure')) return 'IPPure';
            if (text.includes('ipok')) return 'ipok.io';
            return String(source);
        }

        function pcProfileStatusMark(status) {
            const text = String(status || '').trim().toLowerCase();
            if (!text) return '';
            if (['no', 'fail', 'failed', 'blocked', 'false', '0'].includes(text)
                || text.includes('✕') || text.includes('不可用') || text.includes('不支持')
                || text.includes('未通过') || text.includes('失败')) return '✕';
            if (['yes', 'ok', 'pass', 'passed', 'available', 'supported', 'true', 'clean', '1'].includes(text)
                || text.includes('✓') || text.includes('可用') || text.includes('通过')) return '✓';
            return '•';
        }

        function pcFormatPlatformReference(profile) {
            if (!profile) return '—';
            const scenarios = Array.isArray(profile.scenarios) ? profile.scenarios : [];
            const services = Array.isArray(profile.services) ? profile.services : [];
            const media = Array.isArray(profile.media) ? profile.media : [];
            const serviceChecks = () => services.map(item => {
                const label = item.name || item.key;
                const mark = pcProfileStatusMark(item.status);
                return label && mark ? `${label}${mark}` : '';
            }).filter(Boolean);
            const mediaChecks = () => media.map(item => {
                const label = item.name || item.key;
                const mark = pcProfileStatusMark(item.status);
                return label && mark ? `${label}${mark}` : '';
            }).filter(Boolean);
            const scenarioLabels = {
                ai: 'AI',
                ecommerce: '电商',
                ecommerce_shopping: '电商',
                shopping: '电商',
                social: '社媒',
                social_media: '社媒',
                streaming: '流媒体',
                media: '流媒体',
            };
            const parts = scenarios.map(item => {
                const key = String(item.key || item.name || '').toLowerCase();
                const label = scenarioLabels[key] || item.name || item.key || '场景';
                const stars = item.stars !== undefined && item.stars !== null ? `${item.stars}★` : '';
                let checks = [];
                if (key === 'ai') checks = serviceChecks();
                else if (key === 'streaming' || key === 'media') checks = mediaChecks();
                const suffix = checks.length ? `（${checks.join(' · ')}）` : '';
                return `${label}${stars ? ` ${stars}` : ''}${suffix}`;
            }).filter(Boolean);
            if (parts.length) return parts.join(' · ');
            const fallback = [];
            const serviceText = serviceChecks();
            const mediaText = mediaChecks();
            if (serviceText.length) fallback.push(`AI（${serviceText.join(' · ')}）`);
            if (mediaText.length) fallback.push(`流媒体（${mediaText.join(' · ')}）`);
            return fallback.join(' · ') || '—';
        }

        function pcFormatRiskDetail(profile) {
            if (!profile) return '—';
            const parts = [];
            if (profile.blocklist) {
                parts.push(`黑名单 ${profile.blocklist.listed} 命中 / ${profile.blocklist.checked} 洁净`);
            }
            const flags = profile.flags || null;
            if (flags) {
                parts.push(`Tor=${pcYesNo(flags.tor)}`);
                parts.push(`VPN=${pcYesNo(flags.vpn)}`);
                const sources = Array.isArray(profile.sources) ? profile.sources : [];
                const sourceText = sources.length
                    ? `（${sources.map(item => `${item.source} ${item.risk ?? 0}`).join(' · ')}）`
                    : '';
                parts.push(`Abuser=${pcYesNo(flags.abuser)}${sourceText}`);
            }
            return parts.join(' · ') || '—';
        }

        function pcFormatLocation(profile, detail) {
            const code = profile?.country_code || detail?.country || '';
            const country = code ? formatRegionName(code) : '';
            const city = profile?.city || detail?.city || '';
            const region = profile?.region || detail?.region || '';
            const location = [city, region].filter((value, index, list) => value && list.indexOf(value) === index).join(' / ');
            const timezone = profile?.timezone || detail?.timezone || '';
            const drift = profile?.drift_km !== undefined && profile?.drift_km !== null
                ? `偏移 ${Math.round(profile.drift_km)} km`
                : '';
            return [location, country, timezone, drift].filter(Boolean).join(' · ') || '—';
        }

        function pcFormatProfileChain(detail, profile) {
            const parts = [];
            const ttfb = pcTelemetryNumber(detail?.ttfb_ms);
            if (ttfb !== null) parts.push(`<span class="pc-chain-latency">${Math.round(ttfb)} ms</span>`);
            const throughput = pcFormatThroughput(detail?.speed_kbps);
            if (throughput) parts.push(`吞吐 ${pcEscapeHtml(throughput)}`);
            const connected = formatPcDurationZh(detail?.connected_time);
            if (connected) parts.push(`已连 ${pcEscapeHtml(connected)}`);
            const tunnel = String(detail?.tunnel || '').trim();
            const port = pcTelemetryNumber(detail?.port);
            if (tunnel) parts.push(`隧道 ${pcEscapeHtml(tunnel)}${port === null ? '' : ` (:${Math.round(port)})`}`);
            const checked = pcRelativeTime(detail?.latency_checked_at || detail?.purity_checked_at || profile?.checked_at);
            if (checked) parts.push(`${pcEscapeHtml(checked)}检测`);
            return parts.join(' · ') || '—';
        }

        function pcRenderProfileLoading(exitIp, role) {
            const container = document.getElementById('pc-native-score-container');
            if (!container) return;
            const roleLabel = role === 'standby' ? '备用出口' : '主出口';
            container.innerHTML = `<div class="pc-profile-loading">
                <strong>正在获取${roleLabel} IP 详情</strong>
                <span class="pc-font-mono">${pcEscapeHtml(exitIp)}</span>
                <small>优先等待 VPS 心跳直报，旧版节点会自动回退到面板公共画像接口。</small>
            </div>`;
        }

        function pcRenderProfileError(exitIp, role, message) {
            const container = document.getElementById('pc-native-score-container');
            if (!container) return;
            const roleLabel = role === 'standby' ? '备用出口' : '主出口';
            container.innerHTML = `<div class="pc-profile-error">
                <strong>无法获取${roleLabel} IP 详情</strong>
                <span class="pc-font-mono">${pcEscapeHtml(exitIp)}</span>
                <p>${pcEscapeHtml(message || '出口画像接口暂时不可用')}</p>
                <small>可稍后点击「重测纯净度」，或等待 VPS 心跳上报新的出口画像。</small>
            </div>`;
        }

        function pcRenderIpProfileSection(view) {
            const container = document.getElementById('pc-native-score-container');
            if (!container || !view) return;
            const { profile, detail, exitIp, role, source } = view;
            const meta = formatExitPurityMeta({ ...detail, ip_profile: profile }) || {
                typeLabel: '',
                typeTone: 'slate',
                fraudScore: null,
                ipokRisk: null,
                fraudLevelLabel: '待检测',
                ipokLevelLabel: '待检测',
                verdictLabel: '待检测',
                verdictTone: 'neutral',
                verdictProgress: 0,
                hasIpok: false,
                asnOrg: '',
                isResidential: undefined,
                isNative: undefined,
            };
            const sourceLabel = pcProfileSourceLabel(profile?.source || meta.puritySource || '');
            const pills = [];
            if (Number.isFinite(meta.ipokRisk)) {
                pills.push(`<span class="pc-profile-pill" data-tone="${pcEscapeHtml(meta.ipokLevelTone)}" title="IPOK 风险分: ${meta.ipokRisk}">IPOK ${pcEscapeHtml(meta.ipokLevelLabel)}</span>`);
            }
            if (Number.isFinite(meta.fraudScore)) {
                pills.push(`<span class="pc-profile-pill" data-tone="${pcEscapeHtml(meta.fraudLevelTone)}" title="IPPure 风险分: ${meta.fraudScore}">IPPure ${pcEscapeHtml(meta.fraudLevelLabel)}</span>`);
            }
            if (meta.isResidential === true) {
                pills.push('<span class="pc-profile-pill" data-tone="good">住宅宽带</span>');
            } else if (meta.isResidential === false) {
                pills.push('<span class="pc-profile-pill" data-tone="warn">机房 IP</span>');
            } else if (profile?.ip_type) {
                pills.push(`<span class="pc-profile-pill" data-tone="neutral">${pcEscapeHtml(profile.ip_type)}</span>`);
            }
            if (meta.isNative === true) {
                pills.push('<span class="pc-profile-pill" data-tone="good">原生 IP</span>');
            } else if (meta.isNative === false) {
                pills.push('<span class="pc-profile-pill" data-tone="warn">广播 IP</span>');
            } else if (profile?.native_type) {
                pills.push(`<span class="pc-profile-pill" data-tone="neutral">${pcEscapeHtml(profile.native_type)}</span>`);
            }
            if (profile?.shared_users) {
                pills.push(`<span class="pc-profile-pill" data-tone="neutral">共享 ${pcEscapeHtml(profile.shared_users)}</span>`);
            }
            if (sourceLabel) {
                pills.push(`<span class="pc-profile-pill" data-tone="source">来源 ${pcEscapeHtml(sourceLabel)}</span>`);
            }
            const platform = pcFormatPlatformReference(profile);
            const reverse = profile?.reverse || detail?.reverse || '—';
            const riskDetail = pcFormatRiskDetail(profile);
            const operator = profile?.isp || profile?.org || meta.asnOrg || '—';
            const asn = profile?.asn || '—';
            const location = pcFormatLocation(profile, detail);
            const flags = profile?.flags || {};
            const flagText = [
                `proxy=${pcYesNo(flags.proxy)}`,
                `hosting=${pcYesNo(flags.hosting)}`,
                `vpn=${pcYesNo(flags.vpn)}`,
                `mobile=${pcYesNo(flags.mobile)}`,
            ].join(' · ');
            const chain = pcFormatProfileChain(detail, profile);
            const purityBadge = profile ? '✓ 已验证' : '待检测';
            const purityDescription = profile?.purity_label
                || [meta.verdictLabel, meta.typeLabel, sourceLabel ? `来源 ${sourceLabel}` : ''].filter(Boolean).join(' · ')
                || '—';
            const recheckLoading = pcProfileProbeLoading.recheck_purity;
            const latencyLoading = pcProfileProbeLoading.probe_latency;
            const sourceNote = source === 'vps'
                ? '由 VPS 经出口直采缓存，不占用面板公网配额'
                : '由面板公共画像接口补充；VPS 升级后将优先使用直采数据';
            const verdictTone = meta.verdictTone || 'neutral';
            const progress = Math.max(0, Math.min(100, Number(meta.verdictProgress) || 0));
            container.innerHTML = `
                <article class="pc-profile-card pc-profile-summary">
                    <div class="pc-profile-verdict-row">
                        <div>
                            <span class="pc-profile-eyebrow">综合纯净度总评 · ${role === 'standby' ? '备用出口' : '主出口'}</span>
                            <div class="pc-profile-verdict" data-tone="${pcEscapeHtml(verdictTone)}">${pcEscapeHtml(meta.verdictLabel)}</div>
                        </div>
                        <span class="pc-profile-exit-ip pc-font-mono">${pcEscapeHtml(exitIp)}</span>
                    </div>
                    <div class="pc-purity-progress" data-tone="${pcEscapeHtml(verdictTone)}" aria-label="纯净度 ${progress}%">
                        <i style="width: ${progress}%"></i>
                    </div>
                    <div class="pc-profile-pills">${pills.join('')}</div>
                    <div class="pc-profile-facts">
                        <div class="pc-profile-fact"><span>平台可用参考</span><strong>${pcEscapeHtml(platform)}</strong></div>
                        <div class="pc-profile-fact"><span>反向解析</span><strong class="pc-font-mono">${pcEscapeHtml(reverse)}</strong></div>
                        <div class="pc-profile-fact"><span>风险项</span><strong>${pcEscapeHtml(riskDetail)}</strong></div>
                    </div>
                </article>
                <article class="pc-profile-card pc-profile-attribution">
                    <div class="pc-profile-card-head">
                        <h4>出口归属与纯净度</h4>
                        <span class="pc-profile-verified">${pcEscapeHtml(purityBadge)}</span>
                    </div>
                    <div class="pc-profile-description">${pcEscapeHtml(purityDescription)}</div>
                    <div class="pc-profile-facts">
                        <div class="pc-profile-fact"><span>运营商</span><strong>${pcEscapeHtml(operator)}</strong></div>
                        <div class="pc-profile-fact"><span>ASN</span><strong class="pc-font-mono">${pcEscapeHtml(asn)}</strong></div>
                        <div class="pc-profile-fact"><span>位置与时区</span><strong>${pcEscapeHtml(location)}</strong></div>
                        <div class="pc-profile-fact"><span>标记</span><strong>${pcEscapeHtml(flagText)}</strong></div>
                        <div class="pc-profile-fact"><span>实测链路</span><strong>${chain}</strong></div>
                    </div>
                    <div class="pc-profile-footer">
                        <div class="pc-profile-actions">
                            <button type="button" class="pc-btn pc-btn-ghost pc-probe-btn" data-pc-probe="recheck_purity" ${recheckLoading ? 'disabled' : ''}>${recheckLoading ? '重测中...' : '重测纯净度'}</button>
                            <button type="button" class="pc-btn pc-btn-ghost pc-probe-btn" data-pc-probe="probe_latency" ${latencyLoading ? 'disabled' : ''}>${latencyLoading ? '测量中...' : '测延迟'}</button>
                        </div>
                        <small>${pcEscapeHtml(sourceNote)}</small>
                    </div>
                </article>`;
            container.onclick = event => {
                const target = event?.target;
                const button = target?.closest?.('[data-pc-probe]')
                    || (target?.dataset?.pcProbe ? target : null);
                if (!button) return;
                event.preventDefault?.();
                pcRunProfileProbe(button.dataset.pcProbe);
            };
        }

        async function pcLoadIpProfile(ip, requestSeq, role, serverIp, options = {}) {
            const container = document.getElementById('pc-native-score-container');
            if (!container || !ip) return;
            const cacheKey = `${ip}|${role}`;
            const refresh = options.refresh === true;
            const baseDetail = options.baseDetail && typeof options.baseDetail === 'object' ? options.baseDetail : {};
            if (!refresh) {
                const cached = pcProfileFallbackCache.get(cacheKey);
                if (cached && Date.now() - cached.at < 5 * 60 * 1000) {
                    const mergedDetail = { ...baseDetail, ...cached.detail };
                    const profileSignature = `${cached.profile.checked_at || ''}:${cached.profile.source || ''}:${cached.profile.purity_label || ''}:${cached.profile.ip_type || ''}:${cached.profile.native_type || ''}`;
                    pcCurrentScoreKey = `${serverIp}|${role}|${ip}|${profileSignature}|${mergedDetail.fraud_score ?? ''}:${mergedDetail.ipok_risk ?? ''}:${mergedDetail.ttfb_ms ?? ''}:${mergedDetail.speed_kbps ?? ''}:${mergedDetail.latency_checked_at ?? ''}`;
                    pcProfileView = {
                        serverIp,
                        role,
                        exitIp: ip,
                        detail: mergedDetail,
                        profile: cached.profile,
                        source: 'fallback',
                    };
                    pcRenderIpProfileSection(pcProfileView);
                    return;
                }
            }
            if (!refresh || !pcProfileView) pcRenderProfileLoading(ip, role);
            const path = `/api/proxy/ip-profile/${encodeURIComponent(ip)}${refresh ? '?refresh=1' : ''}`;
            try {
                let headers = {};
                if (typeof window.kuiAdminAuthHeader === 'function') {
                    headers = await window.kuiAdminAuthHeader() || {};
                } else {
                    const auth = await getPcAuthHeader('GET', path);
                    if (auth) headers.Authorization = auth;
                }
                const res = await fetch(path, { headers });
                if (requestSeq !== pcScoreRequestSeq) return;
                const text = await res.text();
                if (requestSeq !== pcScoreRequestSeq) return;
                let data;
                try {
                    data = JSON.parse(text || '{}');
                } catch {
                    throw new Error(`出口画像接口返回了非 JSON 数据（HTTP ${res.status}）`);
                }
                if (!res.ok) throw new Error(data?.error || `出口画像接口返回 HTTP ${res.status}`);
                const profile = normalizeIpProfile(data?.ip_profile || data);
                if (!profile) throw new Error('出口画像接口未返回可用数据');
                const fetchedDetail = { ...data, ip_profile: profile };
                const detail = { ...baseDetail, ...fetchedDetail };
                pcProfileFallbackCache.set(cacheKey, { at: Date.now(), profile, detail: fetchedDetail });
                const profileSignature = `${profile.checked_at || ''}:${profile.source || ''}:${profile.purity_label || ''}:${profile.ip_type || ''}:${profile.native_type || ''}`;
                pcCurrentScoreKey = `${serverIp}|${role}|${ip}|${profileSignature}|${detail.fraud_score ?? ''}:${detail.ipok_risk ?? ''}:${detail.ttfb_ms ?? ''}:${detail.speed_kbps ?? ''}:${detail.latency_checked_at ?? ''}`;
                pcProfileView = {
                    serverIp,
                    role,
                    exitIp: ip,
                    detail,
                    profile,
                    source: 'fallback',
                };
                pcRenderIpProfileSection(pcProfileView);
            } catch (error) {
                if (requestSeq !== pcScoreRequestSeq) return;
                pcProfileView = null;
                pcRenderProfileError(ip, role, error?.message || String(error));
            }
        }

        export function pcSetProfileRole(role) {
            const next = role === 'standby' ? 'standby' : 'active';
            if (next === pcProfileRole) return pcProfileRole;
            pcProfileRole = next;
            pcCurrentScoreKey = '';
            pcRenderOverviewFromCache();
            return pcProfileRole;
        }

        export async function pcRunProfileProbe(action = 'recheck_purity') {
            const normalized = action === 'probe_latency' ? 'probe_latency' : 'recheck_purity';
            if (pcProfileProbeLoading[normalized]) return false;
            const selectedIp = document.getElementById('slot-target-ip')?.value || '';
            if (!selectedIp || selectedIp === '*') {
                pcNotifyUser('批量模式或未选择节点时无法触发出口探测', 'warning');
                return false;
            }
            const role = pcProfileRole;
            const initialView = pcProfileView && pcProfileView.serverIp === selectedIp && pcProfileView.role === role
                ? pcProfileView
                : null;
            const initialExitIp = initialView?.exitIp || '';
            const initialBaseDetail = initialView?.detail || null;
            pcProfileProbeLoading[normalized] = true;
            if (pcProfileView) pcRenderIpProfileSection(pcProfileView);
            try {
                const auth = await getPcAuthHeader('POST', '/api/proxy/probe');
                const res = await fetch('/api/proxy/probe', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': auth },
                    body: JSON.stringify({ ip: selectedIp, action: normalized, role }),
                });
                const text = await res.text();
                if (!res.ok) {
                    let message = text;
                    try {
                        const payload = JSON.parse(text);
                        message = payload?.error || payload?.message || text;
                    } catch (_) {}
                    throw new Error(message || `HTTP ${res.status}`);
                }
                pcNotifyUser(normalized === 'recheck_purity'
                    ? '已触发 VPS 纯净度重测，等待心跳回传'
                    : '已触发 VPS 延迟测量，等待心跳回传', 'success');
                const currentSelectedIp = document.getElementById('slot-target-ip')?.value || '';
                if (
                    currentSelectedIp === selectedIp
                    && pcProfileRole === role
                    && initialExitIp
                    && pcProfileView?.source === 'fallback'
                    && pcProfileView?.serverIp === selectedIp
                    && pcProfileView?.role === role
                    && pcProfileView?.exitIp === initialExitIp
                ) {
                    const requestSeq = ++pcScoreRequestSeq;
                    await pcLoadIpProfile(initialExitIp, requestSeq, role, selectedIp, {
                        refresh: true,
                        baseDetail: initialBaseDetail || pcProfileView.detail,
                    });
                }
                return true;
            } catch (error) {
                pcNotifyUser(`出口探测触发失败：${error?.message || error}`, 'error');
                return false;
            } finally {
                pcProfileProbeLoading[normalized] = false;
                if (pcProfileView) pcRenderIpProfileSection(pcProfileView);
            }
        }

        let lastPcHttpFetch = 0;
        let pcHttpServers = [];
        let pcNodeServers = [];
        let pcNodeStateSynced = false;
        let pcNodeStateGeneration = 0;
        let pcNodeFetchSeq = 0;
        const pcIgnoredRealtimeSnapshots = new WeakSet();
        const pcRealtimeRevokedAt = new Map();
        let pcRevocationSessionKey = null;
        const PC_REALTIME_FRESHNESS_FALLBACK_MS = 11 * 60 * 1000;

        function pcCurrentSessionKey() {
            try {
                return typeof sessionStorage !== 'undefined' ? String(sessionStorage.getItem('kui_auth_key') || '') : '';
            } catch (_) {
                return '';
            }
        }

        function pcSyncRevocationSession() {
            const key = pcCurrentSessionKey();
            if (pcRevocationSessionKey === null) {
                pcRevocationSessionKey = key;
                return false;
            }
            if (key !== pcRevocationSessionKey) {
                pcRealtimeRevokedAt.clear();
                pcRevocationSessionKey = key;
                return true;
            }
            return false;
        }

        function pcRealtimeSnapshotUsable(snapshot, now = Date.now()) {
            if (!snapshot || typeof snapshot !== 'object' || !snapshot.ip) return false;
            if (pcIgnoredRealtimeSnapshots.has(snapshot)) return false;
            const proxyState = String(snapshot.proxy_state || '').toLowerCase();
            const realtimeState = String(snapshot.realtime_state || '').toLowerCase();
            if (proxyState === 'offline' || proxyState === 'stale') return false;
            if (realtimeState === 'offline' || realtimeState === 'stale') return false;
            const sampleTs = pcSampleTimestamp(snapshot);
            if (sampleTs >= 1e12) {
                const staleAfter = Number(snapshot.stale_after_ms);
                const freshnessMs = Number.isFinite(staleAfter) && staleAfter > 0
                    ? staleAfter
                    : PC_REALTIME_FRESHNESS_FALLBACK_MS;
                if (now - sampleTs > freshnessMs) return false;
            }
            return true;
        }

        function pcRealtimeOfflineTimestamp(snapshot) {
            if (!snapshot || typeof snapshot !== 'object' || !snapshot.ip) return 0;
            if (pcIgnoredRealtimeSnapshots.has(snapshot)) return 0;
            const proxyState = String(snapshot.proxy_state || '').toLowerCase();
            const realtimeState = String(snapshot.realtime_state || '').toLowerCase();
            const isOffline = proxyState === 'offline' || realtimeState === 'offline';
            const isStale = proxyState === 'stale' || realtimeState === 'stale';
            if (!isOffline && !isStale) return 0;
            const offlineTs = isOffline
                ? Math.max(pcTimestampMs(snapshot.proxy_disconnected_at), pcTimestampMs(snapshot.disconnected_at))
                : 0;
            let staleTs = 0;
            if (isStale) {
                const proxyHeartbeatTs = pcTimestampMs(snapshot.proxy_heartbeat_at);
                const proxyAge = Number(snapshot.proxy_age);
                const proxyObservedStaleTs = proxyState === 'stale' && proxyHeartbeatTs > 0 && Number.isFinite(proxyAge) && proxyAge >= 0
                    ? proxyHeartbeatTs + proxyAge
                    : 0;
                const coreHeartbeatTs = pcTimestampMs(snapshot.core_heartbeat_at);
                const coreAge = Number(snapshot.core_age);
                const coreObservedStaleTs = realtimeState === 'stale' && coreHeartbeatTs > 0 && Number.isFinite(coreAge) && coreAge >= 0
                    ? coreHeartbeatTs + coreAge
                    : 0;
                staleTs = Math.max(pcTimestampMs(snapshot.updated_at), proxyObservedStaleTs, coreObservedStaleTs);
            }
            return Math.max(offlineTs, staleTs);
        }

        export async function pcFetchNodes(throwOnError = false) {
            const fetchSeq = ++pcNodeFetchSeq;
            const generation = pcNodeStateGeneration;
            let httpError = null;
            try {
                pcSyncRevocationSession();
                pcPopulateTargets();
                let servers = [];
                // Realtime is a fast path only. Keep an HTTP snapshot so a missing proxy
                // socket or an incomplete realtime patch cannot hide persisted tunnel data.
                if (Date.now() - lastPcHttpFetch >= 15000) {
                    try {
                        const auth = await getPcAuthHeader('GET', '/api/proxy/nodes');
                        const res = await fetch(`/api/proxy/nodes?t=${Date.now()}`, { headers: { 'Authorization': auth } });
                        if (fetchSeq !== pcNodeFetchSeq || generation !== pcNodeStateGeneration) return false;
                        if (!res.ok) throw new Error(`proxy nodes ${res.status}`);
                        const nodes = await res.json();
                        if (fetchSeq !== pcNodeFetchSeq || generation !== pcNodeStateGeneration) return false;
                        pcHttpServers = Array.isArray(nodes) ? nodes.map(server => ({
                            ...server,
                            _pc_http_sample_ts: pcSampleTimestamp(server),
                        })) : [];
                        lastPcHttpFetch = Date.now();
                    } catch (err) {
                        if (fetchSeq !== pcNodeFetchSeq || generation !== pcNodeStateGeneration) return false;
                        httpError = err;
                    }
                }
                servers = pcHttpServers.map(server => ({ ...server }));
                const now = Date.now();
                const rawRealtimeSnapshots = Object.values(window.kuiRealtimeProxySnapshots || {});
                if (rawRealtimeSnapshots.length || pcRealtimeRevokedAt.size) {
                    const byIp = new Map(servers.map(server => [server.ip, server]));
                    const httpByIp = new Map(pcHttpServers.map(server => [server.ip, server]));
                    rawRealtimeSnapshots.forEach(snapshot => {
                        const offlineTs = pcRealtimeOfflineTimestamp(snapshot);
                        if (offlineTs > 0) {
                            const previousRevoked = pcRealtimeRevokedAt.get(snapshot.ip) || 0;
                            if (offlineTs > previousRevoked) pcRealtimeRevokedAt.set(snapshot.ip, offlineTs);
                        }
                    });
                    if (pcRealtimeRevokedAt.size) {
                        byIp.forEach((existing, ip) => {
                            const revokedTs = pcRealtimeRevokedAt.get(ip) || 0;
                            if (!revokedTs) return;
                            const httpTs = Number(existing._pc_http_sample_ts || 0);
                            if (httpTs > revokedTs) {
                                pcRealtimeRevokedAt.delete(ip);
                            } else {
                                byIp.set(ip, { ...existing, details: '[]' });
                            }
                        });
                    }
                    rawRealtimeSnapshots.forEach(snapshot => {
                        if (pcRealtimeOfflineTimestamp(snapshot) > 0) return;
                        if (!pcRealtimeSnapshotUsable(snapshot, now)) return;
                        const realtimeTs = pcSampleTimestamp(snapshot);
                        const revokedTs = pcRealtimeRevokedAt.get(snapshot.ip) || 0;
                        if (revokedTs > 0) {
                            if (!realtimeTs || realtimeTs <= revokedTs) return;
                            if (Array.isArray(snapshot?.proxy?.details)) {
                                pcRealtimeRevokedAt.delete(snapshot.ip);
                            }
                        }
                        const previous = byIp.get(snapshot.ip) || {};
                        const httpTs = Number(previous._pc_http_sample_ts || 0);
                        if (realtimeTs > 0 && httpTs > 0 && realtimeTs < httpTs) return;
                        byIp.set(snapshot.ip, pcMergeRealtimeServer(previous, snapshot));
                        const httpServer = httpByIp.get(snapshot.ip);
                        if (httpServer && Array.isArray(snapshot?.proxy?.details) && snapshot.proxy.details.length === 0) {
                            const cachedHttpTs = Number(httpServer._pc_http_sample_ts || 0);
                            if (!cachedHttpTs || !realtimeTs || realtimeTs >= cachedHttpTs) {
                                httpServer.details = '[]';
                            }
                        }
                    });
                    servers = Array.from(byIp.values());
                }
                if (fetchSeq !== pcNodeFetchSeq || generation !== pcNodeStateGeneration) return false;
                pcNodeServers = servers.map(server => ({ ...server }));
                pcNodeStateSynced = Boolean(pcNodeServers.length || !httpError || lastPcHttpFetch > 0);
                pcRenderOverviewFromCache();

            } catch (err) {
                console.warn('[pc] nodes failed:', err);
                if (throwOnError) throw err;
            }
            if (httpError) {
                console.warn('[pc] nodes failed:', httpError);
                if (throwOnError) throw httpError;
            }
        }

        export function pcInitProxy() {
            pcStopProxy();

            pcPopulateTargets();
            pcFetchCountries();
            pcLoadConfig();
            pcFetchNodes();
            if (!window.kuiRealtimeConnected) pcInterval = setInterval(pcFetchNodes, 60000);
        }

        export function pcStopProxy(options = {}) {
            const resetSession = Boolean(options && typeof options === 'object' && options.resetSession);
            const sessionChanged = pcSyncRevocationSession();
            if (resetSession) {
                pcRealtimeRevokedAt.clear();
            }
            if (pcInterval) { clearInterval(pcInterval); pcInterval = null; }
            pcCurrentScoreIp = null;
            pcCurrentScoreKey = '';
            pcProfileRole = 'active';
            pcProfileView = null;
            pcProfileFallbackCache.clear();
            pcProfileProbeLoading.recheck_purity = false;
            pcProfileProbeLoading.probe_latency = false;
            pcScoreRequestSeq += 1;
            pcNodeStateGeneration += 1;
            pcNodeFetchSeq += 1;
            lastPcHttpFetch = 0;
            pcHttpServers = [];
            pcNodeServers = [];
            pcNodeStateSynced = false;
            if (document.getElementById('slot-target-ip')) {
                pcRenderOverviewFromCache();
            }
            if (typeof window !== 'undefined' && window.kuiRealtimeProxySnapshots && typeof window.kuiRealtimeProxySnapshots === 'object') {
                for (const snapshot of Object.values(window.kuiRealtimeProxySnapshots)) {
                    if (snapshot && typeof snapshot === 'object') {
                        if (!resetSession && !sessionChanged) {
                            const offlineTs = pcRealtimeOfflineTimestamp(snapshot);
                            if (offlineTs > 0) {
                                const previousRevoked = pcRealtimeRevokedAt.get(snapshot.ip) || 0;
                                if (offlineTs > previousRevoked) pcRealtimeRevokedAt.set(snapshot.ip, offlineTs);
                            }
                        }
                        pcIgnoredRealtimeSnapshots.add(snapshot);
                    }
                }
                try {
                    for (const key of Object.keys(window.kuiRealtimeProxySnapshots)) {
                        delete window.kuiRealtimeProxySnapshots[key];
                    }
                } catch (_) {}
            }
            pcSetHotSwitchButton(document.getElementById('pc-hot-switch-btn'), false, '节点状态未同步，等待刷新');
            pcHideProfileSection();
        }

        // Keep the legacy window bridge for manual refresh and custom integrations.
        Object.assign(window, { pcFetchCountries, pcFetchNodes, pcLoadConfig, pcSaveConfig, pcSwitchIP, pcSwitchProxy, pcPopulateTargets, pcSetCountryFilter, pcToggleCountriesExpanded, pcSelectTargetIp, pcSetLogFilter, pcToggleLogPause, pcCopyLogs, pcToggleBatchMode, pcSetProfileRole, pcRunProfileProbe });
