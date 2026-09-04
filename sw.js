// Eigener Service Worker für die PhysikApps-Simulationen.
//
// Warum nicht der von Flutter mitgelieferte? Der legt seit einigen Versionen
// nichts mehr ab – er meldet sich beim Aktivieren selbst wieder ab. Diese
// Fassung tut zweierlei:
//
//   1. Sie beantwortet Anfragen aus dem Cache, sobald etwas darin liegt.
//   2. Sie holt beim ersten Besuch im Hintergrund alle nachgeladenen
//      Programmteile (`main.dart.js_*.part.js`) ins Haus.
//
// Ergebnis: Der Start bleibt schlank – die Startseite braucht nur
// `main.dart.js` –, und wenig später liegt trotzdem die ganze Sammlung
// bereit. Wer eine Simulation öffnet, wartet dann auf nichts mehr, auch
// nicht im Klassenzimmer ohne Netz.

const CACHE = 'neosim';

// Ohne Antwort nach dieser Zeit gilt eine Anfrage als aussichtslos - dann
// zählt der Cache, statt auf eine zähe Verbindung zu warten (Aufbau eines
// Class-room-WLANs, Funkloch unterwegs). Ein sauberes "kein Netz" kommt vom
// Browser meist viel schneller; das hier fängt die zähen Fälle ab.
const NETZ_ZEITLIMIT = 6000;

// Diese Dateien kommen immer frisch aus dem Netz (und nur ersatzweise aus
// dem Cache). `flutter_bootstrap.js` gehört inhaltlich dazu, wird aber
// gesondert behandelt - siehe `ankerAntwort`.
const IMMER_FRISCH = [
  '',
  'index.html',
  'version.json',
  // Klein und selten geändert, entscheidet aber über Name, Farbe und Icon
  // der Kachel auf dem Startbildschirm – die soll nicht veraltet sein.
  'manifest.json',
];

// Das Grundgerüst. Es muss ausdrücklich abgelegt werden: Beim allerersten
// Besuch ist der Service Worker noch nicht wach, wenn der Browser diese
// Dateien holt – sie kämen also nie durch seine Hände. Was es nicht gibt
// (je nach Flutter-Fassung), wird stillschweigend übergangen.
const GRUNDGERUEST = [
  './',
  'index.html',
  'main.dart.js',
  'flutter.js',
  'manifest.json',
  'favicon.png',
  'version.json',
  'assets/FontManifest.json',
  'assets/AssetManifest.bin.json',
  'assets/AssetManifest.bin',
  'assets/NOTICES',
  'assets/fonts/MaterialIcons-Regular.otf',
  'canvaskit/canvaskit.js',
  'canvaskit/canvaskit.wasm',
  'canvaskit/skwasm.js',
  'canvaskit/skwasm.wasm',
  'canvaskit/skwasm_heavy.js',
  'canvaskit/skwasm_heavy.wasm',
  'canvaskit/chromium/canvaskit.js',
  'canvaskit/chromium/canvaskit.wasm',
];

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    await self.clients.claim();
    const cache = await caches.open(CACHE);
    // Nur beim allerersten Mal leer - danach lag schon eine Fassung vor,
    // um die kümmert sich `ankerAntwort` bei der nächsten Anfrage.
    if (!(await cache.match(neben('main.dart.js')))) await ladeVor(cache);
  })());
});

// Antwort auf den „Auf neue Fassung prüfen“-Knopf im Hinweisfenster der
// App (`lib/home/update_pruefer_web.dart`). `e.source` ist der Tab, der die
// Nachricht geschickt hat - die Antwort geht gezielt an ihn zurück, nicht an
// alle offenen Tabs.
self.addEventListener('message', (e) => {
  if (e.data !== 'pruefen') return;
  const anfragendeSeite = e.source;
  if (!anfragendeSeite) return;
  e.waitUntil((async () => {
    let ergebnis = 'fehler';
    try {
      const cache = await caches.open(CACHE);
      const anfrage = new Request(neben('flutter_bootstrap.js'));
      const antwort = await geholt(anfrage, { cache: 'no-store' });
      if (antwort && antwort.ok) {
        const geaendert = await pruefeUndUebernehmeFassung(cache, anfrage, antwort.clone());
        ergebnis = geaendert ? 'neu' : 'aktuell';
      }
    } catch (fehler) {
      ergebnis = 'fehler';
    }
    anfragendeSeite.postMessage(ergebnis);
  })());
});

self.addEventListener('fetch', (e) => {
  const anfrage = e.request;
  if (anfrage.method !== 'GET') return;
  const url = new URL(anfrage.url);
  if (url.origin !== self.location.origin) return;

  const name = url.pathname.split('/').pop();
  if (name === 'flutter_bootstrap.js') {
    e.respondWith(ankerAntwort(anfrage, e));
  } else if (IMMER_FRISCH.includes(name)) {
    e.respondWith(netzZuerst(anfrage));
  } else {
    e.respondWith(cacheZuerst(anfrage));
  }
});

async function cacheZuerst(anfrage) {
  const cache = await caches.open(CACHE);
  const treffer = await cache.match(anfrage, { ignoreSearch: true });
  if (treffer) return treffer;
  const antwort = await geholt(anfrage);
  if (antwort && antwort.ok) cache.put(anfrage, antwort.clone());
  return antwort;
}

async function netzZuerst(anfrage) {
  const cache = await caches.open(CACHE);
  try {
    const antwort = await geholt(anfrage, { cache: 'no-store' });
    if (antwort && antwort.ok) cache.put(anfrage, antwort.clone());
    return antwort;
  } catch (fehler) {
    return notlage(cache, anfrage);
  }
}

/// Ohne Netz oder bei einer zu zähen Verbindung: das Nächstbeste aus dem
/// Cache. Ohne ihn läuft die Anfrage ins Leere - dann gibt es wirklich
/// nichts, was ohne Netz gezeigt werden könnte.
async function notlage(cache, anfrage) {
  const treffer = await cache.match(anfrage, { ignoreSearch: true });
  if (treffer) return treffer;
  // Ohne Netz landet jeder Link (`…/#/reibung`) auf der Startseite der
  // App; die liegt unter dem Verzeichnis selbst.
  if (anfrage.mode === 'navigate') {
    const start = await cache.match(neben('./'), { ignoreSearch: true });
    if (start) return start;
  }
  throw new Error('Weder Netz noch Cache haben ' + anfrage.url);
}

/// Antwort auf die Anfrage nach `flutter_bootstrap.js` - klein, ändert sich
/// bei jedem Bau und entscheidet deshalb zugleich, ob eine neue Fassung
/// veröffentlicht wurde. Die Seite bekommt sie sofort; der Abgleich mit dem
/// Cache (und ein möglicher Neuaufbau) läuft danach im Hintergrund weiter,
/// damit der Start schlank bleibt.
async function ankerAntwort(anfrage, e) {
  const cache = await caches.open(CACHE);
  let antwort;
  try {
    antwort = await geholt(anfrage, { cache: 'no-store' });
  } catch (fehler) {
    return notlage(cache, anfrage);
  }
  if (antwort && antwort.ok) {
    e.waitUntil(pruefeUndUebernehmeFassung(cache, anfrage, antwort.clone()));
  }
  return antwort;
}

/// Ist eine neue Fassung veröffentlicht worden? Der Vergleich läuft, BEVOR
/// der neue Text den alten im Cache ersetzt - würde zuerst geschrieben,
/// verglichen würde die neue Fassung nur noch mit sich selbst, und ein
/// Unterschied fiele nie mehr auf. Das Ergebnis geht an den Aufrufer zurück,
/// der „Auf neue Fassung prüfen“-Knopf im Hinweisfenster nutzt es.
async function pruefeUndUebernehmeFassung(cache, anfrage, antwort) {
  const alt = await cache.match(anfrage, { ignoreSearch: true });
  const neuerText = await antwort.clone().text();
  const alterText = alt ? await alt.text() : null;

  const geaendert = alterText !== null && alterText !== neuerText;
  if (geaendert) {
    await caches.delete(CACHE);
    const frisch = await caches.open(CACHE);
    await frisch.put(anfrage, antwort.clone());
    await ladeVor(frisch);
  } else {
    await cache.put(anfrage, antwort.clone());
  }
  return geaendert;
}

/// Holt alle nachgeladenen Teile im Hintergrund.
///
/// Ihre Namen stehen im Hauptbündel – eine eigene Liste beim Bauen ist
/// deshalb nicht nötig. Es wird in kleinen Gruppen geladen, damit der
/// laufende Betrieb Vorfahrt behält.
async function ladeVor(cache) {
  const haupt = neben('main.dart.js');
  let text;
  try {
    const antwort = await cacheZuerstText(cache, haupt);
    if (!antwort) return;
    text = antwort;
  } catch (fehler) {
    return;
  }

  const namen = [
    ...GRUNDGERUEST,
    ...new Set(text.match(/main\.dart\.js_\d+\.part\.js/g) || []),
    ...await beilagen(),
  ];
  const offen = [];
  for (const name of namen) {
    const adresse = neben(name);
    if (!(await cache.match(adresse, { ignoreSearch: true }))) offen.push(adresse);
  }

  const gleichzeitig = 6;
  for (let i = 0; i < offen.length; i += gleichzeitig) {
    await Promise.all(offen.slice(i, i + gleichzeitig).map(async (adresse) => {
      try {
        const antwort = await geholt(adresse);
        if (antwort && antwort.ok) await cache.put(adresse, antwort);
      } catch (fehler) {
        // Einzelne Ausfälle sind kein Beinbruch: Das Stück wird beim
        // Öffnen der Kachel nachgeholt.
      }
    }));
  }
}

/// Die Beilagen der App – Töne, Bilder, Logos.
///
/// Ihre Namen stehen im Asset-Verzeichnis, das Flutter in einer eigenen
/// Binärform ablegt; die Pfade sind darin aber als lesbarer Text enthalten
/// und lassen sich herausfischen. Ohne sie bliebe eine Simulation offline
/// zwar bedienbar, aber stumm.
async function beilagen() {
  try {
    const antwort = await geholt(neben('assets/AssetManifest.bin.json'));
    if (!antwort || !antwort.ok) return [];
    const roh = await antwort.json();
    const text = atob(roh);
    const pfade = new Set(text.match(/assets\/[A-Za-z0-9_\-./]+\.[A-Za-z0-9]+/g) || []);
    return [...pfade].map((p) => 'assets/' + p);
  } catch (fehler) {
    return [];
  }
}

async function cacheZuerstText(cache, adresse) {
  const treffer = await cache.match(adresse, { ignoreSearch: true });
  if (treffer) return treffer.text();
  const antwort = await geholt(adresse);
  if (!antwort || !antwort.ok) return null;
  await cache.put(adresse, antwort.clone());
  return antwort.text();
}

/// `fetch` mit Zeitlimit: Nach `NETZ_ZEITLIMIT` bricht die Anfrage ab, statt
/// eine zähe Verbindung endlos offenzuhalten - ein sauberes "kein Netz"
/// meldet der Browser meist ohnehin schon vorher von selbst.
async function geholt(anfrageOderAdresse, optionen = {}) {
  const steuerung = new AbortController();
  const uhr = setTimeout(() => steuerung.abort(), NETZ_ZEITLIMIT);
  try {
    return await fetch(anfrageOderAdresse, { ...optionen, signal: steuerung.signal });
  } finally {
    clearTimeout(uhr);
  }
}

/// Adresse einer Datei neben diesem Service Worker – die App liegt je nach
/// Server in einem Unterverzeichnis (`/physikapps-simulationen/`).
function neben(name) {
  return new URL(name, self.location).href;
}
