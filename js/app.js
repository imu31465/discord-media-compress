const FFMPEG_DRIVER_URL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/esm/index.js';
const FFMPEG_CLASS_WORKER_URL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/esm/worker.js';
// The class worker is a module worker, so it must import the ESM core build.
const FFMPEG_CORE_BASE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm';
const FFMPEG_LOAD_TIMEOUT_MS = 60_000;
const BUILD_ID = 'ultrafast-encode-speed';
const VIDEO_PRESET = 'ultrafast';
const AUDIO_BITRATE = 160_000;
const INITIAL_SIZE_FACTOR = 0.92;
const RETRY_SAFETY_FACTOR = 0.98;
const MAX_ATTEMPTS = 3;

const $ = (id) => document.getElementById(id);
const els = {
  fileInput: $('fileInput'), dropzone: $('dropzone'), browseButton: $('browseButton'), fileCard: $('fileCard'),
  fileName: $('fileName'), fileMeta: $('fileMeta'), removeFile: $('removeFile'), sourcePreviewWrap: $('sourcePreviewWrap'),
  sourcePreview: $('sourcePreview'), sourceResolution: $('sourceResolution'), mediaDetails: $('mediaDetails'),
  detailDuration: $('detailDuration'), detailResolution: $('detailResolution'), detailAudio: $('detailAudio'),
  detailAudioCodec: $('detailAudioCodec'), planGrid: $('planGrid'), customSize: $('customSize'), compressButton: $('compressButton'),
  cancelButton: $('cancelButton'), processState: $('processState'), emptyResult: $('emptyResult'), progressArea: $('progressArea'),
  progressTitle: $('progressTitle'), progressPercent: $('progressPercent'), progressFill: $('progressFill'), progressMessage: $('progressMessage'),
  progressAttempt: $('progressAttempt'), resultArea: $('resultArea'), resultSize: $('resultSize'), resultSavingLabel: $('resultSavingLabel'),
  resultSaving: $('resultSaving'), audioCheck: $('audioCheck'), audioCheckTitle: $('audioCheckTitle'), audioCheckText: $('audioCheckText'),
  resultPreview: $('resultPreview'), downloadButton: $('downloadButton'), resetButton: $('resetButton'), resultNote: $('resultNote'),
  logDetails: $('logDetails'), logOutput: $('logOutput'), logCount: $('logCount'), themeToggle: $('themeToggle'), toast: $('toast'),
};

let selectedFile = null;
let sourceObjectURL = null;
let resultObjectURL = null;
let resultFilename = '';
let ffmpeg = null;
let ffmpegLoadPromise = null;
let coreObjectURLs = [];
let busy = false;
let cancelled = false;
let currentTargetMB = 20;
let currentMaxSide = 1280;
let currentDuration = 0;
let progressRange = { start: 0, span: 1 };
let logs = [];
let toastTimer = null;

function setBusy(value) {
  busy = value;
  els.compressButton.disabled = value || !selectedFile;
  els.removeFile.disabled = value;
  els.cancelButton.classList.toggle('hidden', !value);
  els.planGrid.querySelectorAll('button').forEach((button) => { button.disabled = value; });
  els.customSize.disabled = value;
}

function setState(label, kind = '') {
  els.processState.textContent = label;
  els.processState.className = `state-pill${kind ? ` ${kind}` : ''}`;
}

function setProgress(percent, title, message, attemptLabel = '') {
  const value = Math.max(0, Math.min(100, Number(percent) || 0));
  els.progressArea.classList.remove('hidden');
  els.emptyResult.classList.add('hidden');
  els.resultArea.classList.add('hidden');
  els.progressFill.style.width = `${value}%`;
  els.progressPercent.textContent = `${Math.round(value)}%`;
  if (title) els.progressTitle.textContent = title;
  if (message) els.progressMessage.textContent = message;
  els.progressAttempt.textContent = attemptLabel;
}

function addLog(message) {
  const clean = String(message ?? '').trim();
  if (!clean) return;
  logs.push(clean);
  if (logs.length > 100) logs.shift();
  els.logOutput.textContent = logs.join('\n');
  els.logCount.textContent = `${logs.length} lines`;
  if (els.logDetails.open) els.logOutput.scrollTop = els.logOutput.scrollHeight;
}

function clearLogs() {
  logs = [];
  els.logOutput.textContent = 'ログはまだありません。';
  els.logCount.textContent = '0 lines';
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('visible'), 3200);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / (1024 ** 2)).toFixed(2)} MB`;
  return `${(bytes / (1024 ** 3)).toFixed(2)} GB`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${minutes}:${String(secs).padStart(2, '0')}`;
}

function safeBaseName(name) {
  return name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 100) || 'video';
}

function getExtension(name) {
  const match = String(name).toLowerCase().match(/\.([a-z0-9]{1,8})$/);
  return match ? match[1] : 'mp4';
}

function isVideoFile(file) {
  if (file.type && file.type.startsWith('video/')) return true;
  return /\.(mp4|m4v|mov|mkv|webm|avi|wmv|flv|mpeg|mpg|3gp|ts|mts|m2ts|ogv)$/i.test(file.name);
}

function resetResult() {
  if (resultObjectURL) URL.revokeObjectURL(resultObjectURL);
  resultObjectURL = null;
  resultFilename = '';
  els.resultPreview.removeAttribute('src');
  els.resultPreview.load();
  els.resultArea.classList.add('hidden');
  els.progressArea.classList.add('hidden');
  els.emptyResult.classList.remove('hidden');
  els.emptyResult.querySelector('p').textContent = '圧縮を開始すると、ここに結果が表示されます。';
  setState('待機中');
}

function chooseFile(file) {
  if (!file) return;
  if (!isVideoFile(file)) {
    showToast('動画ファイルを選択してください。');
    return;
  }
  if (busy) return;

  selectedFile = file;
  resetResult();
  clearLogs();
  if (sourceObjectURL) URL.revokeObjectURL(sourceObjectURL);
  sourceObjectURL = URL.createObjectURL(file);
  els.fileName.textContent = file.name;
  const largeFileNote = file.size > 250 * 1024 * 1024 ? ' · 大容量: メモリ使用量に注意' : '';
  els.fileMeta.textContent = `${formatBytes(file.size)} · ${getExtension(file.name).toUpperCase()}${largeFileNote}`;
  els.fileCard.classList.remove('hidden');
  els.dropzone.classList.add('hidden');
  els.sourcePreviewWrap.classList.remove('hidden');
  els.sourcePreview.src = sourceObjectURL;
  els.sourcePreview.onerror = () => {
    els.sourcePreviewWrap.classList.add('hidden');
    addLog('このブラウザでは入力動画のプレビューを表示できません。圧縮可否には影響しません。');
  };
  els.mediaDetails.classList.add('hidden');
  els.sourceResolution.textContent = 'メタデータ未解析';
  els.compressButton.disabled = false;
  showToast('動画を読み込みました。');
}

function clearSelectedFile() {
  if (busy) return;
  selectedFile = null;
  if (sourceObjectURL) URL.revokeObjectURL(sourceObjectURL);
  sourceObjectURL = null;
  els.sourcePreview.removeAttribute('src');
  els.sourcePreview.load();
  els.sourcePreviewWrap.classList.add('hidden');
  els.fileCard.classList.add('hidden');
  els.dropzone.classList.remove('hidden');
  els.mediaDetails.classList.add('hidden');
  els.fileInput.value = '';
  els.compressButton.disabled = true;
  resetResult();
}

function updatePlan(target, label = 'Custom') {
  currentTargetMB = target;
  currentMaxSide = target >= 500 ? null : target >= 50 ? 1920 : 1280;
  els.customSize.value = String(target);
  els.planGrid.querySelectorAll('.plan-option').forEach((button) => {
    button.classList.toggle('selected', button.dataset.label === label);
  });
}

function onCustomSizeChange() {
  const value = Number(els.customSize.value);
  els.planGrid.querySelectorAll('.plan-option').forEach((button) => button.classList.remove('selected'));
  if (!Number.isFinite(value) || value < 1 || value > 500) {
    currentTargetMB = NaN;
    return;
  }
  currentTargetMB = value;
  currentMaxSide = value >= 500 ? null : value >= 50 ? 1920 : 1280;
}

async function fetchBlobURL(url, mimeType) {
  const response = await fetch(url, { mode: 'cors', cache: 'force-cache' });
  if (!response.ok) throw new Error(`FFmpegファイルの取得に失敗しました (${response.status})`);
  const blob = await response.blob();
  const objectURL = URL.createObjectURL(new Blob([blob], { type: mimeType }));
  coreObjectURLs.push(objectURL);
  return objectURL;
}

function releaseCoreURLs() {
  for (const url of coreObjectURLs) URL.revokeObjectURL(url);
  coreObjectURLs = [];
}

function createModuleWorkerProxyURL(moduleURL) {
  // The package ESM is loaded from jsDelivr, but browsers block a Worker
  // constructed directly from a cross-origin script URL. A same-origin Blob
  // worker can import the CDN module (and its relative dependencies) normally.
  const source = `import "${moduleURL}";`;
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  coreObjectURLs.push(url);
  return url;
}

async function ensureFFmpeg() {
  if (ffmpeg?.loaded) return ffmpeg;
  if (ffmpegLoadPromise) return ffmpegLoadPromise;

  ffmpegLoadPromise = (async () => {
    setProgress(3, '圧縮エンジンを準備中', 'FFmpeg本体を読み込んでいます。初回は約31MBのダウンロードが必要です。');
    addLog('FFmpeg WebAssembly のロードを開始');
    const module = await import(FFMPEG_DRIVER_URL);
    if (typeof module.FFmpeg !== 'function') throw new Error('FFmpegモジュールを初期化できませんでした。');

    const engine = new module.FFmpeg();
    engine.on('log', ({ message }) => {
      addLog(message);
      const time = String(message).match(/time=(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/);
      if (time && currentDuration > 0 && busy) {
        const seconds = Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3]);
        const local = Math.min(.94, seconds / currentDuration);
        setProgress(progressRange.start + local * progressRange.span, '動画をエンコード中', `${formatDuration(seconds)} / ${formatDuration(currentDuration)}`, progressRange.label || '');
      }
    });
    engine.on('progress', ({ progress }) => {
      const value = Number(progress);
      if (Number.isFinite(value) && value >= 0 && value <= 1 && busy) {
        setProgress(progressRange.start + Math.min(.94, value) * progressRange.span, '動画をエンコード中', '映像と音声を処理しています。', progressRange.label || '');
      }
    });

    try {
      setProgress(6, '圧縮エンジンを準備中', 'FFmpegコアを取得しています。');
      // Keep the core on its CDN URL. The module worker imports this ESM
      // entrypoint directly; a Blob URL made from the UMD build has no default
      // export and causes "failed to import ffmpeg-core.js".
      const coreURL = `${FFMPEG_CORE_BASE}/ffmpeg-core.js`;
      const wasmURL = `${FFMPEG_CORE_BASE}/ffmpeg-core.wasm`;
      const classWorkerURL = createModuleWorkerProxyURL(FFMPEG_CLASS_WORKER_URL);
      addLog('FFmpeg Worker を初期化しています');
      addLog('ES Module 版 FFmpeg コアを読み込んでいます');
      let loadTimeout;
      try {
        await Promise.race([
          engine.load({ coreURL, wasmURL, classWorkerURL }),
          new Promise((_, reject) => {
            loadTimeout = setTimeout(
              () => reject(new Error('FFmpeg Worker の初期化が60秒以内に完了しませんでした。CDNへの接続、広告ブロッカー、ブラウザのWorker制限を確認してください。')),
              FFMPEG_LOAD_TIMEOUT_MS,
            );
          }),
        ]);
      } finally {
        clearTimeout(loadTimeout);
      }
      ffmpeg = engine;
      addLog('FFmpeg WebAssembly のロードが完了');
      return engine;
    } catch (error) {
      try { engine.terminate(); } catch { /* load failed before worker startup */ }
      releaseCoreURLs();
      throw error;
    }
  })();

  try {
    return await ffmpegLoadPromise;
  } finally {
    ffmpegLoadPromise = null;
  }
}

async function probeMedia(engine, inputPath, outputPath, countPackets = false) {
  // ffmpeg.wasm's ffprobe wrapper expects the input path before its
  // special "-o" output-file option (same order as the upstream API example).
  const args = [
    '-v', 'error',
    ...(countPackets ? ['-count_packets'] : []),
    '-show_streams',
    '-show_format',
    '-of', 'json',
    inputPath,
    '-o', outputPath,
  ];
  try {
    addLog(`FFprobe: ${countPackets ? 'packet-count probe' : 'input probe'} を実行`);
    const code = await engine.ffprobe(args);

    // @ffmpeg/core 0.12.10 has a known issue where ffprobe() may return -1
    // even after successfully writing its requested output file. The output
    // JSON is authoritative: read and validate it before deciding this failed.
    let raw;
    try {
      raw = await engine.readFile(outputPath, 'utf8');
    } catch (readError) {
      addLog(`FFprobe returned ${code}; output file could not be read: ${readError instanceof Error ? readError.message : String(readError)}`);
      throw new Error(`動画の解析結果を取得できませんでした (FFprobe exit code: ${code})。動画形式またはメタデータを確認してください。`);
    }

    let probe;
    try {
      probe = JSON.parse(raw);
    } catch {
      addLog(`FFprobe output was not valid JSON (exit code: ${code})`);
      throw new Error('動画メタデータをJSONとして読み取れませんでした。処理ログを確認してください。');
    }

    if (!probe || !Array.isArray(probe.streams)) {
      addLog(`FFprobe JSON is incomplete (exit code: ${code})`);
      throw new Error('動画の解析結果にストリーム情報がありません。ファイル形式または破損を確認してください。');
    }

    if (code !== 0) {
      addLog(`FFprobe returned ${code}, but valid metadata JSON was produced. Treating probe as successful (core 0.12.10 return-code issue).`);
    }
    return probe;
  } finally {
    await safeDelete(engine, outputPath);
  }
}

async function safeDelete(engine, path) {
  try { await engine.deleteFile(path); } catch { /* already removed */ }
}

function getMediaInfo(probe) {
  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  const videoStreams = streams.filter((stream) => stream.codec_type === 'video');
  const audioStreams = streams.filter((stream) => stream.codec_type === 'audio');
  const video = videoStreams[0];
  const duration = Number(probe.format?.duration || video?.duration || 0);
  if (!video) throw new Error('映像トラックが見つかりません。');
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('動画の長さを取得できませんでした。');
  return { streams, videoStreams, audioStreams, video, duration, format: probe.format || {} };
}

function renderMediaInfo(info) {
  const resolution = `${info.video.width || '?'} × ${info.video.height || '?'}`;
  const codecs = info.audioStreams.length
    ? [...new Set(info.audioStreams.map((stream) => stream.codec_name || 'unknown').map((name) => name.toUpperCase()))].join(' / ')
    : 'なし';
  els.detailDuration.textContent = formatDuration(info.duration);
  els.detailResolution.textContent = resolution;
  els.detailAudio.textContent = `${info.audioStreams.length} トラック`;
  els.detailAudioCodec.textContent = codecs;
  els.mediaDetails.classList.remove('hidden');
  els.sourceResolution.textContent = resolution;
}

function buildEncodeArgs(inputPath, outputPath, bitrate, maxSide) {
  const args = [
    '-hide_banner', '-y', '-i', inputPath,
    '-map', '0:v:0',
    '-map', '0:a?',
    '-map_metadata', '0',
    '-map_chapters', '0',
    '-c:v', 'libx264',
    '-preset', VIDEO_PRESET,
    '-pix_fmt', 'yuv420p',
    '-b:v', String(Math.max(50_000, Math.floor(bitrate))),
    '-maxrate', String(Math.max(50_000, Math.floor(bitrate))),
    '-bufsize', String(Math.max(100_000, Math.floor(bitrate * 2))),
    '-c:a', 'aac',
    '-b:a', `${Math.round(AUDIO_BITRATE / 1000)}k`,
    '-movflags', '+faststart',
    '-max_muxing_queue_size', '2048',
  ];
  if (maxSide) {
    args.push('-vf', `scale=w='min(${maxSide},iw)':h='min(${maxSide},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`);
  }
  args.push('-f', 'mp4', outputPath);
  return args;
}

function updateAudioCheck(sourceCount, outputCount, verified) {
  els.audioCheck.classList.remove('warning');
  const audioCheckIcon = els.audioCheck.querySelector('.audio-check-icon');
  if (sourceCount === 0 && outputCount === 0) {
    els.audioCheckTitle.textContent = '入力に音声トラックはありません';
    els.audioCheckText.textContent = '元動画が無音のため、音声トラックの追加は行っていません。';
    audioCheckIcon.textContent = '–';
    return;
  }
  if (verified && sourceCount === outputCount) {
    els.audioCheckTitle.textContent = `音声 ${sourceCount} トラックを保持・検証済み`;
    els.audioCheckText.textContent = '入力と出力のトラック数が一致し、出力音声のデコード検証にも成功しました。';
    audioCheckIcon.textContent = '✓';
  }
}

function showResult(blob, originalSize, outputSize, sourceAudioCount, outputAudioCount, verified, note = '', outputExtension = 'mp4', passThrough = false) {
  if (resultObjectURL) URL.revokeObjectURL(resultObjectURL);
  resultObjectURL = URL.createObjectURL(blob);
  resultFilename = passThrough
    ? `${safeBaseName(selectedFile.name)}-original.${outputExtension}`
    : `${safeBaseName(selectedFile.name)}-compressed.${outputExtension}`;
  els.resultPreview.src = resultObjectURL;
  els.resultSize.textContent = formatBytes(outputSize);
  const ratio = (1 - outputSize / originalSize) * 100;
  els.resultSavingLabel.textContent = ratio >= 0 ? 'SIZE REDUCTION' : 'SIZE INCREASE';
  els.resultSaving.textContent = ratio >= 0 ? `${ratio.toFixed(1)}% smaller` : `${Math.abs(ratio).toFixed(1)}% larger`;
  if (passThrough) {
    els.audioCheck.classList.remove('warning');
    els.audioCheck.querySelector('.audio-check-icon').textContent = '✓';
    els.audioCheckTitle.textContent = '元ファイルをそのまま保持';
    els.audioCheckText.textContent = '再エンコードせず、音声トラックを含む元データを変更せずに保存します。';
  } else {
    updateAudioCheck(sourceAudioCount, outputAudioCount, verified);
  }
  els.resultNote.textContent = note;
  els.progressArea.classList.add('hidden');
  els.emptyResult.classList.add('hidden');
  els.resultArea.classList.remove('hidden');
  const safeLimit = currentTargetMB * 1024 * 1024;
  if (passThrough) setState('完了 · 元データ維持', 'success');
  else if (outputSize > safeLimit) setState('サイズ超過 · 音声保持', 'warning');
  else setState(sourceAudioCount > 0 ? '完了 · 音声検証済み' : '完了 · 音声なし', 'success');
}

function makeProgressCallback(attempt) {
  const step = 72 / MAX_ATTEMPTS;
  progressRange = {
    start: 12 + attempt * step,
    span: step,
    label: `${attempt + 1} / ${MAX_ATTEMPTS} 回目`,
  };
}

async function runCompression() {
  if (!selectedFile || busy) return;
  if (!Number.isFinite(currentTargetMB) || currentTargetMB < 1 || currentTargetMB > 500) {
    showToast('目標サイズは1〜500MBで指定してください。');
    return;
  }

  clearLogs();
  addLog(`SONIC KEEP build: ${BUILD_ID}`);
  resetResult();
  cancelled = false;
  setBusy(true);
  setState('処理中', 'running');
  els.progressArea.classList.remove('hidden');
  const file = selectedFile;
  const targetBytes = currentTargetMB * 1024 * 1024;
  const safeTargetBytes = targetBytes * 0.95;

  // Already-small files are returned as-is. No decode/re-encode means their audio is untouched.
  if (file.size <= safeTargetBytes) {
    const unchanged = new Blob([file], { type: file.type || 'application/octet-stream' });
    showResult(unchanged, file.size, file.size, 0, 0, true,
      '元ファイルが目標サイズ以内のため、再エンコードせずそのまま保存します。映像・音声ともに元データを変更していません。', getExtension(file.name), true);
    setBusy(false);
    return;
  }

  let engine = null;
  let inputPath = '';
  let outputPath = '';
  let outputData = null;
  let sourceInfo = null;
  let outputInfo = null;
  try {
    engine = await ensureFFmpeg();
    if (cancelled) return;

    const ext = getExtension(file.name);
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    inputPath = `/source-${stamp}.${ext}`;
    outputPath = `/result-${stamp}.mp4`;

    setProgress(9, '動画を解析中', 'ファイルをブラウザ内の一時領域へ読み込んでいます。');
    addLog(`入力ファイル: ${file.name} (${formatBytes(file.size)})`);
    await engine.writeFile(inputPath, new Uint8Array(await file.arrayBuffer()));
    if (cancelled) return;

    const probePath = `/probe-${stamp}.json`;
    const probe = await probeMedia(engine, inputPath, probePath);
    sourceInfo = getMediaInfo(probe);
    currentDuration = sourceInfo.duration;
    renderMediaInfo(sourceInfo);
    addLog(`入力解析: ${sourceInfo.video.width}x${sourceInfo.video.height}, ${formatDuration(sourceInfo.duration)}, 音声 ${sourceInfo.audioStreams.length} トラック`);
    sourceInfo.audioStreams.forEach((stream, index) => addLog(`音声 ${index + 1}: ${stream.codec_name || 'unknown'} / ${stream.channels || '?'} ch / ${stream.sample_rate || '?'} Hz`));

    if (sourceInfo.audioStreams.length > 0) {
      addLog('音声保持モード: 全音声ストリームをAACへ変換して出力');
    } else {
      addLog('入力に音声トラックはありません');
    }

    const audioBudget = sourceInfo.audioStreams.length * AUDIO_BITRATE;
    // Start slightly below the hard safety limit to account for muxing and
    // rate-control variance. This is tuned from real output: the old 95%
    // estimate landed just over its limit and forced a second full encode.
    const initialBudgetBytes = targetBytes * INITIAL_SIZE_FACTOR;
    let videoBitrate = Math.max(80_000, Math.floor((initialBudgetBytes * 8) / sourceInfo.duration - audioBudget));
    addLog(`初期サイズ目標: ${(INITIAL_SIZE_FACTOR * 100).toFixed(0)}% / 再試行判定: ${(safeTargetBytes / targetBytes * 100).toFixed(0)}%`);
    let finalSize = 0;
    let lastAttemptOverLimit = false;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (cancelled) return;
      await safeDelete(engine, outputPath);
      makeProgressCallback(attempt);
      const title = `動画を圧縮中 (${attempt + 1}/${MAX_ATTEMPTS})`;
      setProgress(progressRange.start, title, `映像 ${Math.round(videoBitrate / 1000)} kbps · 音声 ${sourceInfo.audioStreams.length} トラック`, progressRange.label);
      addLog(`エンコード ${attempt + 1}/${MAX_ATTEMPTS}: video bitrate ${Math.round(videoBitrate / 1000)} kbps`);
      addLog(`エンコーダー設定: libx264 / preset ${VIDEO_PRESET}`);

      const exitCode = await engine.exec(buildEncodeArgs(inputPath, outputPath, videoBitrate, currentMaxSide));
      if (cancelled) return;
      if (exitCode !== 0) throw new Error('動画のエンコードに失敗しました。ログを確認してください。音声を含む形式に対応できない場合は、無音ファイルを出力せず処理を停止します。');

      const attemptProbePath = `/attempt-${stamp}.json`;
      const attemptProbe = await probeMedia(engine, outputPath, attemptProbePath);
      finalSize = Number(attemptProbe.format?.size);
      if (!Number.isFinite(finalSize) || finalSize <= 0) throw new Error('圧縮後のファイルサイズを確認できませんでした。');
      lastAttemptOverLimit = finalSize > safeTargetBytes;
      addLog(`出力サイズ: ${formatBytes(finalSize)} (目標 ${formatBytes(safeTargetBytes)})`);
      if (!lastAttemptOverLimit || attempt === MAX_ATTEMPTS - 1) break;

      outputData = null;
      const corrected = Math.max(50_000, Math.floor(videoBitrate * (safeTargetBytes / finalSize) * RETRY_SAFETY_FACTOR));
      if (corrected >= videoBitrate) break;
      videoBitrate = corrected;
      addLog(`実測サイズからビットレートを再調整: ${Math.round(videoBitrate / 1000)} kbps (補正係数 ${RETRY_SAFETY_FACTOR})`);
    }

    if (cancelled) return;
    setProgress(88, '音声を検証中', '出力ファイルの音声トラックを再解析しています。');
    addLog('出力メタデータを検証');
    const outputProbePath = `/verify-${stamp}.json`;
    const outputProbe = await probeMedia(engine, outputPath, outputProbePath, true);
    outputInfo = getMediaInfo(outputProbe);
    finalSize = Number(outputInfo.format.size) || finalSize;
    const sourceAudioCount = sourceInfo.audioStreams.length;
    const outputAudioCount = outputInfo.audioStreams.length;

    if (sourceAudioCount !== outputAudioCount) {
      throw new Error(`音声トラック数が一致しません。入力 ${sourceAudioCount} / 出力 ${outputAudioCount}。安全のためダウンロードを停止しました。`);
    }
    if (sourceAudioCount > 0) {
      if (outputInfo.audioStreams.some((stream) => Number(stream.nb_read_packets || 0) <= 0)) {
        throw new Error('出力音声に有効なパケットがありません。安全のためダウンロードを停止しました。');
      }
      if (outputInfo.audioStreams.some((stream) => stream.codec_name !== 'aac')) {
        throw new Error('出力音声がAACではありません。音声検証に失敗したためダウンロードを停止しました。');
      }
      setProgress(91, '音声を検証中', 'すべての音声トラックをデコードできるか確認しています。');
      const audioDecodeCode = await engine.exec([
        '-hide_banner', '-v', 'error', '-xerror', '-i', outputPath,
        '-map', '0:a', '-f', 'null', '-',
      ]);
      if (cancelled) return;
      if (audioDecodeCode !== 0) throw new Error('出力音声のデコード検証に失敗しました。安全のためダウンロードを停止しました。');
      addLog(`音声検証成功: ${sourceAudioCount} トラック / AAC / デコード可能`);
    } else {
      addLog('音声検証: 入力・出力ともに音声トラックなし');
    }

    // Read the encoded video only after all audio-preservation checks have passed.
    outputData = await engine.readFile(outputPath);
    if (outputData.byteLength !== finalSize) {
      addLog(`ファイルサイズ補正: probe ${finalSize} bytes / read ${outputData.byteLength} bytes`);
      finalSize = outputData.byteLength;
    }
    const blob = new Blob([outputData], { type: 'video/mp4' });
    outputData = null;
    let note = sourceAudioCount > 0
      ? '音声はAACへ再エンコードしています。入力の全音声トラックと出力のトラック数が一致し、出力音声を最後までデコードできることを確認しました。'
      : '入力に音声トラックはありません。映像のみをMP4へ変換しました。';
    if (lastAttemptOverLimit) {
      note += finalSize > targetBytes
        ? ` なお、3回の調整後も指定上限を超えています (${formatBytes(finalSize)})。音声を削除してサイズを合わせることはせず、音声を保持した結果を表示しています。`
        : ` なお、内部の安全マージンには収まりませんでしたが、指定上限内です (${formatBytes(finalSize)})。`;
    }
    showResult(blob, file.size, finalSize, sourceAudioCount, outputAudioCount, true, note);
    addLog('処理完了: 音声検証後にダウンロードを有効化');
  } catch (error) {
    if (cancelled) return;
    const message = error instanceof Error ? error.message : String(error);
    addLog(`ERROR: ${message}`);
    setState('エラー', 'error');
    els.progressArea.classList.add('hidden');
    els.resultArea.classList.add('hidden');
    els.emptyResult.classList.remove('hidden');
    els.emptyResult.querySelector('p').textContent = message;
    showToast(message.length > 85 ? '処理に失敗しました。処理ログを確認してください。' : message);
  } finally {
    if (!engine && !ffmpeg?.loaded) releaseCoreURLs();
    if (engine && !cancelled) {
      await safeDelete(engine, inputPath);
      await safeDelete(engine, outputPath);
    }
    if (!cancelled) setBusy(false);
    if (cancelled) {
      if (engine) { try { engine.terminate(); } catch { /* already terminated */ } }
      ffmpeg = null;
      releaseCoreURLs();
      setBusy(false);
      setState('キャンセル済み');
      els.progressArea.classList.add('hidden');
      els.emptyResult.classList.remove('hidden');
      els.emptyResult.querySelector('p').textContent = '処理はキャンセルされました。';
    }
  }
}

function cancelCompression() {
  if (!busy) return;
  cancelled = true;
  addLog('処理をキャンセルしています');
  if (ffmpeg) {
    try { ffmpeg.terminate(); } catch { /* worker already stopped */ }
  }
  ffmpeg = null;
  releaseCoreURLs();
}

function downloadResult() {
  if (!resultObjectURL || !resultFilename) return;
  const anchor = document.createElement('a');
  anchor.href = resultObjectURL;
  anchor.download = resultFilename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function resetForAnother() {
  if (busy) return;
  clearSelectedFile();
  els.emptyResult.querySelector('p').textContent = '圧縮を開始すると、ここに結果が表示されます。';
  clearLogs();
}

function initTheme() {
  const saved = localStorage.getItem('sonic-keep-theme');
  if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
  els.themeToggle.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('sonic-keep-theme', next);
  });
}

// File selection / drag & drop
els.browseButton.addEventListener('click', (event) => { event.stopPropagation(); els.fileInput.click(); });
els.dropzone.addEventListener('click', (event) => {
  if (event.target.closest('button')) return;
  els.fileInput.click();
});
els.dropzone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); els.fileInput.click(); }
});
els.fileInput.addEventListener('change', () => chooseFile(els.fileInput.files?.[0]));
['dragenter', 'dragover'].forEach((name) => els.dropzone.addEventListener(name, (event) => {
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
  els.dropzone.classList.add('dragover');
}));
['dragleave', 'drop'].forEach((name) => els.dropzone.addEventListener(name, (event) => {
  event.preventDefault();
  els.dropzone.classList.remove('dragover');
}));
els.dropzone.addEventListener('drop', (event) => chooseFile(event.dataTransfer.files?.[0]));
els.removeFile.addEventListener('click', clearSelectedFile);

// Presets / custom target size
els.planGrid.querySelectorAll('.plan-option').forEach((button) => {
  button.addEventListener('click', () => updatePlan(Number(button.dataset.size), button.dataset.label));
});
els.customSize.addEventListener('input', onCustomSizeChange);
els.customSize.addEventListener('change', () => {
  onCustomSizeChange();
  if (!Number.isFinite(currentTargetMB)) showToast('目標サイズは1〜500MBで指定してください。');
});

// Actions
els.compressButton.addEventListener('click', runCompression);
els.cancelButton.addEventListener('click', cancelCompression);
els.downloadButton.addEventListener('click', downloadResult);
els.resetButton.addEventListener('click', resetForAnother);

// Theme and initial controls
initTheme();
setBusy(false);
