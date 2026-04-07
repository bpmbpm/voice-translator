/**
 * Голосовой переводчик ver3 — основной JS-модуль (ES-модуль)
 *
 * Используемые технологии:
 *  - Распознавание речи: Web Speech API (SpeechRecognition)
 *  - Перевод: Bergamot WASM (@browsermt/bergamot-translator) — полностью локально
 *  - Синтез речи: Web Speech API (SpeechSynthesis)
 *
 * Bergamot загружает нейросетевую модель (~15 МБ) при первом запуске,
 * браузер кэширует её. Последующие запуски — мгновенные.
 *
 * Для работы SharedArrayBuffer (требование WASM-движка) нужны заголовки
 * Cross-Origin-Opener-Policy: same-origin и Cross-Origin-Embedder-Policy: require-corp.
 * На GitHub Pages они устанавливаются через coi-serviceworker.js.
 */

// ============================================================
// Конфигурация
// ============================================================
const config = {
  translationDirection: "ru-en",  // "ru-en" или "en-ru"
  voiceGender: "female",           // "female" или "male"
  speechRate: 1.0,
  pauseDuration: 1500              // мс
};

// ============================================================
// Константы
// ============================================================

/** Соответствие направлений языковым кодам */
const LANG_CODES = {
  "ru-en": { source: "ru-RU", target: "en-US", from: "ru", to: "en" },
  "en-ru": { source: "en-US", target: "ru-RU", from: "en", to: "ru" }
};

/**
 * Базовый URL CDN для Bergamot WASM
 * Версия 0.4.9 — последняя стабильная из @browsermt/bergamot-translator
 */
const BERGAMOT_CDN = "https://cdn.jsdelivr.net/npm/@browsermt/bergamot-translator@0.4.9";

/**
 * Базовый URL для моделей (S3 от Mozilla)
 * Для каждого направления нужны три файла: модель, лексика, словарь
 */
const MODEL_BASE = "https://storage.googleapis.com/bergamot-models-sandbox/0.4.0";

/** Описание файлов модели для каждого направления */
const MODEL_FILES = {
  "ruen": [
    { name: "model.ruen.intgemm.alphas.bin", type: "model" },
    { name: "lex.50.50.ruen.s2t.bin",       type: "lex"   },
    { name: "vocab.ruen.spm",               type: "vocab" }
  ],
  "enru": [
    { name: "model.enru.intgemm.alphas.bin", type: "model" },
    { name: "lex.50.50.enru.s2t.bin",       type: "lex"   },
    { name: "vocab.enru.spm",               type: "vocab" }
  ]
};

// ============================================================
// Модуль перевода Bergamot (BergamotTranslator)
// ============================================================
const BergamotTranslator = (() => {
  // Кэш загруженных моделей: { "ruen": { model, lex, vocab }, ... }
  const modelCache = {};

  // Загруженный WASM-модуль
  let TranslationWorker = null;

  /**
   * Загружает один файл модели по URL с отслеживанием прогресса
   * @param {string} url
   * @param {function} onProgress — (loaded, total) => void
   * @returns {Promise<ArrayBuffer>}
   */
  async function fetchWithProgress(url, onProgress) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Ошибка загрузки ${url}: HTTP ${response.status}`);
    }
    const contentLength = parseInt(response.headers.get("Content-Length") || "0", 10);
    const reader = response.body.getReader();
    const chunks = [];
    let loaded = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      if (onProgress) onProgress(loaded, contentLength || loaded);
    }

    // Объединяем чанки в один ArrayBuffer
    const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result.buffer;
  }

  /**
   * Загружает все файлы модели для заданного направления
   * @param {string} direction — "ruen" или "enru"
   * @param {function} onProgress — (percent, label) => void
   * @returns {Promise<{model, lex, vocab}>}
   */
  async function loadModel(direction, onProgress) {
    if (modelCache[direction]) return modelCache[direction];

    const files = MODEL_FILES[direction];
    const buffers = {};
    let fileIdx = 0;

    for (const file of files) {
      fileIdx++;
      const url = `${MODEL_BASE}/${direction}/${file.name}`;
      const label = `Загрузка файла ${fileIdx}/${files.length}: ${file.name}`;

      const buf = await fetchWithProgress(url, (loaded, total) => {
        const pct = total ? Math.round((loaded / total) * 100) : 0;
        if (onProgress) onProgress(
          // Общий прогресс: каждый файл — 1/3
          Math.round(((fileIdx - 1) / files.length + (pct / 100) / files.length) * 100),
          `${label} (${pct}%)`
        );
      });
      buffers[file.type] = buf;
    }

    if (onProgress) onProgress(100, "Модель загружена");
    modelCache[direction] = buffers;
    return buffers;
  }

  /**
   * Инициализирует движок Bergamot (загружает WASM через importScripts CDN)
   * @returns {Promise<object>} — экземпляр TranslationService
   */
  async function initEngine(onProgress) {
    if (TranslationWorker) return TranslationWorker;

    if (onProgress) onProgress(0, "Загрузка WASM-движка...");

    // Динамически импортируем JS-обёртку из CDN
    const module = await import(`${BERGAMOT_CDN}/translator.js`);
    TranslationWorker = module;

    if (onProgress) onProgress(100, "WASM-движок готов");
    return TranslationWorker;
  }

  /**
   * Переводит текст
   * @param {string} text — исходный текст
   * @param {string} direction — "ruen" или "enru"
   * @param {function} onModelProgress — прогресс загрузки модели
   * @returns {Promise<string>} — переведённый текст
   */
  async function translate(text, direction, onModelProgress) {
    if (!text || !text.trim()) return "";

    // Шаг 1: инициализация движка
    const engine = await initEngine(onModelProgress);

    // Шаг 2: загрузка модели
    const modelBuffers = await loadModel(direction, onModelProgress);

    // Шаг 3: создание TranslationService и перевод
    // API @browsermt/bergamot-translator:
    //   new TranslationService(config) → service
    //   service.translate(request) → response
    const service = new engine.TranslationService({ cacheSize: 0 });

    const [srcLang, tgtLang] = direction.length === 4
      ? [direction.slice(0, 2), direction.slice(2)]
      : direction.split("-");

    const languageModel = service.loadModel(
      srcLang,
      tgtLang,
      modelBuffers.model,
      modelBuffers.lex,
      modelBuffers.vocab
    );

    const request = {
      texts: [{ text, html: false }],
      qualityScores: false,
      alignments: false,
      sentenceMappings: false
    };

    const response = await service.translate(languageModel, request);
    service.delete();

    // Извлекаем результат из ответа
    const result = response.get(request.texts[0]);
    return result ? result.translation.text : text;
  }

  return { translate };
})();

// ============================================================
// Резервный переводчик через MyMemory API (fallback)
// ============================================================
const FallbackTranslator = {
  async translate(text, langPair) {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${langPair}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (data.responseStatus !== 200) throw new Error(data.responseDetails);
    return data.responseData.translatedText;
  }
};

// ============================================================
// Модуль синтеза речи (SpeechSynthesizer)
// ============================================================
const SpeechSynthesizer = {
  speak(text, lang, gender, rate) {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang;
    utterance.rate = rate;

    const voices = window.speechSynthesis.getVoices();
    const matching = voices.filter(v => v.lang.startsWith(lang.split("-")[0]));
    const keywords = gender === "female"
      ? ["female", "woman", "женский"]
      : ["male", "man", "мужской"];
    const genderVoice = matching.find(v =>
      keywords.some(kw => v.name.toLowerCase().includes(kw))
    );
    utterance.voice = genderVoice || matching[0] || null;

    window.speechSynthesis.speak(utterance);
  }
};

// ============================================================
// Модуль распознавания речи (SpeechRecognizer)
// ============================================================
const SpeechRecognizer = (() => {
  let recognition = null;
  let pauseTimer = null;
  let interimText = "";
  let finalText = "";
  let isRunning = false;

  function start({ lang, pauseDuration, onInterim, onFinal, onError }) {
    const SpeechRecognitionAPI =
      window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognitionAPI) {
      onError("SpeechRecognition не поддерживается. Используйте Chrome или Edge.");
      return;
    }

    recognition = new SpeechRecognitionAPI();
    recognition.lang = lang;
    recognition.continuous = true;
    recognition.interimResults = true;

    finalText = "";
    interimText = "";
    isRunning = true;

    recognition.onresult = (event) => {
      interimText = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          finalText += result[0].transcript;
        } else {
          interimText += result[0].transcript;
        }
      }
      onInterim(finalText + interimText);

      clearTimeout(pauseTimer);
      pauseTimer = setTimeout(() => {
        const blockText = (finalText + interimText).trim();
        if (blockText) {
          onFinal(blockText);
          finalText = "";
          interimText = "";
        }
      }, pauseDuration);
    };

    recognition.onerror = (event) => {
      if (event.error !== "no-speech") {
        onError(`Ошибка распознавания: ${event.error}`);
      }
    };

    recognition.onend = () => {
      if (isRunning) recognition.start();
    };

    recognition.start();
  }

  function stop() {
    isRunning = false;
    clearTimeout(pauseTimer);
    if (recognition) {
      recognition.stop();
      recognition = null;
    }
  }

  return { start, stop };
})();

// ============================================================
// Основной контроллер приложения
// ============================================================
const App = (() => {
  let isActive = false;
  let bergamotReady = false;   // движок Bergamot инициализирован?
  const el = {};               // кэш DOM-элементов

  /** Вспомогательная функция: получить direction-ключ для модели */
  function getModelDirection() {
    return config.translationDirection.replace("-", "");  // "ru-en" → "ruen"
  }

  /** Инициализация после загрузки DOM */
  async function init() {
    el.startBtn       = document.getElementById("startBtn");
    el.stopBtn        = document.getElementById("stopBtn");
    el.statusEl       = document.getElementById("status");
    el.sourceText     = document.getElementById("sourceText");
    el.targetText     = document.getElementById("targetText");
    el.sourceLang     = document.getElementById("sourceLangLabel");
    el.targetLang     = document.getElementById("targetLangLabel");
    el.dirSelect      = document.getElementById("dirSelect");
    el.genderSelect   = document.getElementById("genderSelect");
    el.rateInput      = document.getElementById("rateInput");
    el.pauseInput     = document.getElementById("pauseInput");
    el.rateValue      = document.getElementById("rateValue");
    el.pauseValue     = document.getElementById("pauseValue");
    el.modelProgress  = document.getElementById("modelProgress");
    el.modelProgressBar   = document.getElementById("modelProgressBar");
    el.modelProgressLabel = document.getElementById("modelProgressLabel");

    loadConfigToUI();

    el.startBtn.addEventListener("click", startTranslation);
    el.stopBtn.addEventListener("click", stopTranslation);

    el.rateInput.addEventListener("input", () => {
      el.rateValue.textContent = el.rateInput.value;
    });
    el.pauseInput.addEventListener("input", () => {
      el.pauseValue.textContent = el.pauseInput.value + " мс";
    });

    document.getElementById("applyConfig").addEventListener("click", applyConfig);

    // Предзагружаем движок и модель для текущего направления
    await preloadModel();
  }

  /** Предзагружает WASM-движок и модель перевода */
  async function preloadModel() {
    const direction = getModelDirection();
    setStatus("Загрузка WASM-движка и модели перевода...", "loading");
    showProgress(true);

    try {
      await BergamotTranslator.translate("test", direction, (pct, label) => {
        updateProgress(pct, label);
      });
      bergamotReady = true;
      setStatus("Движок готов. Нажмите «Старт»", "ready");
      showProgress(false);
      el.startBtn.disabled = false;
    } catch (err) {
      // Bergamot не загрузился — сообщаем, что будет использован запасной вариант
      console.warn("Bergamot не доступен, используется MyMemory API:", err);
      bergamotReady = false;
      setStatus("Локальный движок недоступен → используется MyMemory API. Нажмите «Старт»", "ready");
      showProgress(false);
      el.startBtn.disabled = false;
    }
  }

  function loadConfigToUI() {
    el.dirSelect.value    = config.translationDirection;
    el.genderSelect.value = config.voiceGender;
    el.rateInput.value    = config.speechRate;
    el.rateValue.textContent  = config.speechRate;
    el.pauseInput.value   = config.pauseDuration;
    el.pauseValue.textContent = config.pauseDuration + " мс";
    updateLangLabels();
  }

  function updateLangLabels() {
    const labels = {
      "ru-en": { source: "Русский", target: "Английский" },
      "en-ru": { source: "Английский", target: "Русский" }
    };
    const l = labels[config.translationDirection];
    el.sourceLang.textContent = l.source;
    el.targetLang.textContent = l.target;
  }

  function applyConfig() {
    const prevDirection = config.translationDirection;
    config.translationDirection = el.dirSelect.value;
    config.voiceGender  = el.genderSelect.value;
    config.speechRate   = parseFloat(el.rateInput.value);
    config.pauseDuration = parseInt(el.pauseInput.value, 10);

    updateLangLabels();
    setStatus("Настройки применены", "ready");

    // Если направление изменилось — предзагружаем новую модель
    if (config.translationDirection !== prevDirection) {
      bergamotReady = false;
      if (isActive) { stopTranslation(); }
      preloadModel();
      return;
    }

    if (isActive) {
      stopTranslation();
      setTimeout(startTranslation, 300);
    }
  }

  function startTranslation() {
    if (isActive) return;
    isActive = true;

    el.startBtn.disabled = true;
    el.stopBtn.disabled  = false;
    setStatus("Слушаю...");

    const langs = LANG_CODES[config.translationDirection];

    SpeechRecognizer.start({
      lang: langs.source,
      pauseDuration: config.pauseDuration,

      onInterim: (text) => {
        el.sourceText.textContent = text;
      },

      onFinal: async (text) => {
        el.sourceText.textContent = text;
        setStatus("Перевожу...");

        try {
          let translatedText;

          if (bergamotReady) {
            // Используем локальный Bergamot WASM
            const direction = getModelDirection();
            translatedText = await BergamotTranslator.translate(text, direction);
          } else {
            // Резервный вариант — MyMemory API
            const [src, tgt] = config.translationDirection.split("-");
            translatedText = await FallbackTranslator.translate(text, `${src}|${tgt}`);
          }

          el.targetText.textContent = translatedText;
          setStatus("Озвучиваю...");

          SpeechSynthesizer.speak(
            translatedText,
            langs.target,
            config.voiceGender,
            config.speechRate
          );

          setStatus("Слушаю...");
        } catch (err) {
          setStatus(`Ошибка перевода: ${err.message}`, "error");
        }
      },

      onError: (msg) => {
        setStatus(msg, "error");
        stopTranslation();
      }
    });
  }

  function stopTranslation() {
    if (!isActive) return;
    isActive = false;

    SpeechRecognizer.stop();
    window.speechSynthesis.cancel();

    el.startBtn.disabled = false;
    el.stopBtn.disabled  = true;
    setStatus("Остановлено");
  }

  function setStatus(msg, type = "") {
    el.statusEl.textContent = msg;
    el.statusEl.className = "status" + (type ? ` status--${type}` : "");
  }

  function showProgress(visible) {
    el.modelProgress.classList.toggle("visible", visible);
  }

  function updateProgress(pct, label) {
    el.modelProgressBar.style.width = pct + "%";
    el.modelProgressLabel.textContent = label;
  }

  return { init };
})();

document.addEventListener("DOMContentLoaded", App.init);
