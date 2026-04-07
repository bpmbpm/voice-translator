# Альтернативные варианты self-hosted перевода в браузере

В данном документе рассмотрены варианты создания **полностью self-hosted** переводчика
на собственной JS-библиотеке, работающей без внешних серверов и доступной на GitHub Pages.

---

## 1. Bergamot Translator (WASM) — используется в ver3

**Репозиторий:** https://github.com/browsermt/bergamot-translator  
**NPM:** `@browsermt/bergamot-translator` / `@mkljczk/bergamot-translator`  
**Лицензия:** MPL-2.0

### Подход
Использование официального WASM-порта движка Marian NMT от Mozilla.
Модели загружаются с CDN (S3 или GCS), затем кэшируются браузером.

### Архитектура интеграции
```
index.html
  └── translator.js (ES-модуль)
        ├── import @browsermt/bergamot-translator (CDN)
        │     ├── translator.js — JS API
        │     └── translator-worker.js + .wasm — Web Worker
        └── загрузка моделей (model.bin + lex.bin + vocab.spm)
```

### Заимствование кода из ver1/ver2
Полностью переиспользованы без изменений:
- `SpeechRecognizer` — модуль распознавания речи
- `SpeechSynthesizer` — модуль синтеза речи
- `App` — контроллер приложения и UI
- Все стили CSS
- Структура HTML-разметки

Заменён только `Translator` → `BergamotTranslator`.

### Проблемы и ограничения
1. **SharedArrayBuffer требует COOP/COEP** — обойдено через `coi-serviceworker.js`
2. **Первая загрузка ~15 МБ** — необходимо уведомить пользователя (прогресс-бар)
3. **Worker URL cross-origin** — worker нужно хостить на том же домене или использовать
   `importScripts` внутри blob URL
4. **Мобильные устройства** — медленнее из-за CPU-only вычислений
5. **Перезагрузка страницы** при первом запуске (регистрация Service Worker)

---

## 2. LibreTranslate.js — клиент к self-hosted LibreTranslate

**Репозиторий:** https://github.com/LibreTranslate/LibreTranslate  
**NPM:** нет официального browser-bundle, используется REST API  
**Лицензия:** AGPL-3.0

### Подход
LibreTranslate — Python-сервер с REST API. Его можно задеплоить на собственном
сервере/VPS. Браузерный клиент обращается к нему по HTTP. Это уже реализовано в ver2.

**Вариант «полного self-hosted в браузере»** здесь невозможен — Python-бэкенд обязателен.

### Заимствование кода из ver1/ver2
- `ver2/translator.js` — полностью готовый клиент с обработкой API-ключей
- `ver2/index.html` — UI с полем ввода URL сервера

### Проблемы и ограничения
1. Требует работающего сервера LibreTranslate
2. Не работает на GitHub Pages (нужен сервер)
3. Проблемы с CORS при обращении к стороннему серверу
4. Затраты на хостинг (~$5–20/мес. VPS)

---

## 3. Transformers.js (Xenova) — WASM-порт HuggingFace

**Репозиторий:** https://github.com/xenova/transformers.js  
**NPM:** `@xenova/transformers`  
**CDN:** `https://cdn.jsdelivr.net/npm/@xenova/transformers`  
**Лицензия:** Apache-2.0

### Подход
Порт HuggingFace Transformers на JavaScript/WASM через ONNX Runtime Web.
Поддерживает модели перевода (Helsinki-NLP, NLLB, mBART и другие) в формате ONNX.

### Пример интеграции

```javascript
import { pipeline } from "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/transformers.min.js";

// Загрузка модели Helsinki-NLP/opus-mt-ru-en (~300 МБ в ONNX-формате)
const translator = await pipeline("translation", "Xenova/opus-mt-ru-en");

// Перевод
const result = await translator("Привет мир", {
  src_lang: "ru",
  tgt_lang: "en"
});
console.log(result[0].translation_text); // "Hello world"
```

### Заимствование кода из ver1/ver2
- Вся структура `SpeechRecognizer`, `SpeechSynthesizer`, `App` без изменений
- Замена только блока `Translator.translate()` на вызов `pipeline()`

### Структура файлов (аналогична ver3)
```
ver_transformers/
├── index.html
├── translator.js      ← заменить BergamotTranslator на XenovaTranslator
└── coi-serviceworker.js  ← обязателен (ONNX Runtime тоже требует SharedArrayBuffer)
```

### Доступные модели для ru↔en

| Модель | Направление | Размер ONNX | Качество |
|--------|------------|-------------|---------|
| `Xenova/opus-mt-ru-en` | ru→en | ~300 МБ | хорошее |
| `Xenova/opus-mt-en-ru` | en→ru | ~300 МБ | хорошее |
| `Xenova/nllb-200-distilled-600M` | многоязычный | ~1.2 ГБ | отличное |

### Проблемы и ограничения
1. **Огромный размер модели** — 300 МБ+ при первой загрузке (vs 15 МБ у Bergamot)
2. **Долгая инициализация** — первый перевод может занять 30–60 с
3. **SharedArrayBuffer** — те же COOP/COEP требования, что и у Bergamot
4. **Скорость перевода** — медленнее Bergamot из-за ONNX Runtime vs Marian
5. **Преимущество**: поддерживает **200+ языков** (NLLB) против 12 у Bergamot

---

## 4. Самостоятельная JS-библиотека на основе кода Bergamot

### Идея
Форк `bergamot-translator` с минимальными зависимостями, оптимизированный
под конкретные языковые пары и упакованный как единый .js + .wasm файл.

### Шаги реализации

1. **Клонирование репозитория**
   ```bash
   git clone https://github.com/browsermt/bergamot-translator
   cd bergamot-translator
   ```

2. **Сборка WASM через Emscripten**
   ```bash
   # Установка Emscripten SDK
   git clone https://github.com/emscripten-core/emsdk
   cd emsdk && ./emsdk install latest && ./emsdk activate latest
   source ./emsdk_env.sh

   # Сборка
   cd ../bergamot-translator
   mkdir build-wasm && cd build-wasm
   emcmake cmake .. \
     -DCOMPILE_WASM=ON \
     -DUSE_SENTENCEPIECE=ON \
     -DUSE_INTGEMM=ON
   emmake make -j4
   ```

3. **Встройка моделей**
   Модели можно встроить напрямую в WASM через Emscripten `--preload-file`,
   создав единый bundle:
   ```bash
   emcmake cmake .. -DPRELOAD_MODELS=ON -DMODEL_DIR=/path/to/models
   ```
   Это позволяет создать один файл `translator.data` (~20 МБ),
   загружаемый вместе с WASM.

4. **Минималистичный JS-wrapper** (заимствование из ver3)
   ```javascript
   // Вместо CDN-импорта — локальный файл
   import { TranslationService } from "./bergamot.js";
   ```

### Преимущества собственной сборки
- Полный контроль над версиями и зависимостями
- Возможность встроить модели в WASM-бандл
- Нет зависимости от внешних CDN
- Можно оптимизировать размер (убрать неиспользуемые языки)

### Проблемы и ограничения
1. **Сложность сборки** — требует Emscripten, CMake, Docker или специфичного окружения
2. **Время сборки** — 20–40 минут на современном ПК
3. **Размер итогового бандла** — WASM ~5 МБ + модель ~15 МБ = ~20 МБ
4. **Поддержка** — при обновлении Marian NMT нужна пересборка
5. **CI/CD сложность** — сборка WASM в GitHub Actions требует настройки

---

## 5. Writable Service Worker + IndexedDB кэш моделей

### Идея
Расширение ver3: Service Worker кэширует модели в IndexedDB для работы полностью
в оффлайн-режиме (не только через HTTP Cache API).

### Реализация

```javascript
// sw.js — Service Worker с кэшированием моделей
const MODEL_CACHE = "bergamot-models-v1";

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Кэшируем только запросы к моделям
  if (url.hostname === "storage.googleapis.com" &&
      url.pathname.includes("bergamot-models")) {
    event.respondWith(
      caches.open(MODEL_CACHE).then(async cache => {
        const cached = await cache.match(event.request);
        if (cached) return cached;
        const response = await fetch(event.request);
        cache.put(event.request, response.clone());
        return response;
      })
    );
  }
});
```

### Проблемы и ограничения
1. **Конфликт с coi-serviceworker** — два Service Worker не могут управлять одним scope
   → нужно объединить кэширующий SW с coi-serviceworker
2. **Размер кэша** — браузеры могут очищать Cache API при нехватке места
3. **Первый запуск** — всё равно требует загрузки модели

---

## Сравнительная таблица

| Вариант | Браузер без сервера | GitHub Pages | ru↔en | Размер | Скорость init | Качество |
|---------|-------------------|--------------|-------|--------|---------------|---------|
| **Bergamot (ver3)** | ✅ | ✅ | ✅ | ~15 МБ | ~30–60 с | хорошее |
| LibreTranslate | ❌ (нужен сервер) | ❌ | ✅ | н/д | мгновенно | хорошее |
| Transformers.js | ✅ | ✅ | ✅ | ~300 МБ | ~60–120 с | отличное |
| Bergamot self-build | ✅ | ✅ | ✅ | ~20 МБ | ~30–60 с | хорошее |
| SW + IndexedDB | ✅ | ✅ | ✅ | ~15 МБ | ~30 с (первый) | хорошее |

---

## Рекомендация

Для **браузерного self-hosted перевода** оптимален выбор ver3 (Bergamot):
наименьший размер модели, хорошее качество, активная поддержка Mozilla,
простая интеграция через CDN.

**Transformers.js** рекомендуется если нужна поддержка многих языков (200+)
и размер первой загрузки не критичен.

**Собственная сборка Bergamot** рекомендуется если нужна полная автономность
без зависимости от внешних CDN.
