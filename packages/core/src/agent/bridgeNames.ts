// 서브 이름 발급 (0.5.0 3단계, B-7 "이름").
//
// 이름 하나가 세 자리를 겸한다 — trees/ 아래 worktree 폴더 이름, agentbridge/ 접두사를 뗀
// 브랜치 이름, agent 명령이 받는 서브의 id. 셋을 따로 두면 서로 옮겨 적는 자리가 생기므로
// 하나로 묶는다. 그래서 밖에서 원하는 이름을 받지 않는다 — 이름이 곧 경로가 되고, 밖에서
// 들어온 문자열을 쓰면 정규화와 경로 탈출 검사가 새로 필요해진다.
//
// 위키데이터에서 받은 실재 교량 이름 500개 풀에서 뽑는다. 같은 프로젝트 안에서만 공유하는
// 이름이라 동시에 사는 서브 수가 상한이고, 그 수는 500 근처에 가지 않는다.
//
// 디스크를 읽지 않는 순수 함수다. 살아 있는 서브 이름, trees/ 폴더 목록, agentbridge/ 브랜치
// 목록, 과거 사용 이력은 전부 호출처(B-5의 agent start 처리)가 모아서 넘긴다.

// 실재하는 교량의 이름 500개. 위키데이터에서 다리(Q12280)와 그 하위 분류의 항목을 받아
// 언어판 링크 수(널리 알려진 정도)로 정렬한 뒤, 위에서부터 골랐다. 사람이 옮겨 적지 않았으므로
// 실재하지 않는 이름이 섞일 자리가 없다.
//
// 다듬은 규칙 셋. 발음 구별 부호는 ASCII로 내리고(ö → oe가 아니라 o), 괄호나 쉼표가 든 표기는
// 이름이 아니라 구분자라 뺐다. 설명일 뿐인 것(Old Bridge, Stone Bridge)도 뺐다 — 화면에서 서로
// 구분이 안 된다. 꼬리의 bridge는 남는 부분이 두 토큰 이상일 때만 뗐다(golden-gate는 되고
// london-bridge는 안 되는 이유가 이것이다).
export const BRIDGE_NAMES: readonly string[] = [
  "golden-gate", "london-bridge", "tower-bridge", "millennium-bridge", "brooklyn-bridge", "millau-viaduct", "oresund-bridge", "akashi-kaikyo",
  "bridge-of-sighs", "crimean-bridge", "sydney-harbour", "charles-bridge", "stari-most", "pont-du-gard", "bosphorus-bridge", "ponte-vecchio",
  "aqueduct-of-segovia", "forth-bridge", "verrazzano-narrows", "rialto-bridge", "vasco-da-gama", "mehmed-pasa-sokolovic", "rainbow-bridge", "danyang-kunshan-grand",
  "george-washington", "great-belt-fixed-link", "westminster-bridge", "yavuz-sultan-selim", "1915-canakkale", "vizcaya-bridge", "hong-kong-zhuhai-macau", "szechenyi-chain",
  "little-belt", "waterloo-bridge", "pont-alexandre-iii", "pont-neuf", "francis-scott-key", "manhattan-bridge", "rio-antirrio", "king-fahd-causeway",
  "fatih-sultan-mehmet", "pontcysyllte-aqueduct", "bridge-of-the-americas", "russky-bridge", "albert-bridge", "polcevera-viaduct", "galata-bridge", "menai-suspension",
  "pont-saint-benezet", "ponte-sant-angelo", "pont-de-normandie", "victoria-bridge", "ponte-milvio", "trajan-s", "pont-des-arts", "danube-bridge",
  "alcantara-bridge", "williamsburg-bridge", "hangzhou-bay", "qingdao-jiaozhou-bay", "oland-bridge", "humber-bridge", "si-o-se-pol", "new-europe",
  "blackfriars-bridge", "25-de-abril", "southwark-bridge", "vauxhall-bridge", "magdeburg-canal", "trinity-bridge", "tsing-ma", "confederation-bridge",
  "chapel-bridge", "richmond-bridge", "first-thai-lao-friendship", "queensboro-bridge", "donghai-bridge", "lambeth-bridge", "rio-niteroi", "ponte-della-liberta",
  "gamla-bron", "latin-bridge", "pont-de-la-concorde", "pont-de-l-alma", "glienicke-bridge", "luiz-i", "pons-aemilius", "britannia-bridge",
  "elisabeth-bridge", "huajiang-canyon", "maria-valeria", "stone-bridge-in-skopje", "peljesac-bridge", "ponte-dell-accademia", "howrah-bridge", "quebec-bridge",
  "burapha-withi-expressway", "lugou-bridge", "mackinac-bridge", "puente-nuevo", "paton-bridge", "chelsea-bridge", "severn-bridge", "erasmusbrug",
  "oberbaum-bridge", "margaret-bridge", "pont-de-bir-hakeim", "reichsbrucke", "landwasser-viaduct", "megyeri-bridge", "zhangjiajie-glass", "franjo-tudman",
  "palace-bridge", "pont-mirabeau", "hohenzollern-bridge", "khaju-bridge", "clifton-suspension", "pont-d-iena", "duge-bridge", "suramadu-bridge",
  "sino-korean-friendship", "the-helix", "osmangazi-bridge", "broadway-bridge", "eshima-ohashi", "i-35w-mississippi-river", "band-e-kaisar", "maslenica-bridge",
  "pons-fabricius", "samuel-beckett", "ponte-pietra", "europabrucke", "hammersmith-bridge", "dragon-bridge", "pulteney-bridge", "kyiv-metro",
  "ambassador-bridge", "kazungula-bridge", "ponte-della-costituzione", "pamban-bridge", "gateshead-millennium", "chenab-bridge", "ada-bridge", "khudafarin-bridges",
  "pons-cestius", "goltzsch-viaduct", "krk-bridge", "ponte-d-augusto", "jerusalem-chords", "puente-romano", "suez-canal", "baluarte-bridge",
  "octavio-frias-de-oliveira", "garabit-viaduct", "petofi-bridge", "penang-bridge", "pons-sublicius", "johor-singapore-causeway", "mes-bridge", "three-countries",
  "puente-de-la-mujer", "kyrkbron", "puente-del-alamillo", "grosvenor-bridge", "arpad-bridge", "ataturk-bridge", "sidu-river", "pont-saint-michel",
  "tatara-bridge", "pont-au-change", "rakoczi-bridge", "kazarma-mycenaean", "allenby-bridge", "veterans-memorial", "ponte-de-d-maria-pia", "antonivka-road",
  "magere-brug", "svinesund-bridge", "juscelino-kubitschek", "tay-rail", "krymsky-bridge", "ponte-sisto", "runyang-yangtze-river", "pont-d-austerlitz",
  "anichkov-bridge", "monnow-bridge", "haghtanak-bridge", "pegasus-bridge", "tromso-bridge", "jubilee-bridge", "theodor-heuss", "pont-au-double",
  "glenfinnan-viaduct", "zhivopisny-bridge", "hardanger-bridge", "pont-royal", "sutong-yangtze-river", "brusio-spiral", "pont-des-invalides", "can-tho",
  "waldschlosschen-bridge", "pont-notre-dame", "bolshoy-obukhovsky", "pont-saint-louis", "dyavolski-most", "victoria-falls", "kanmon-bridge", "korea-russia-friendship",
  "laguna-garzon", "hell-gate", "lupu-bridge", "battersea-bridge", "sky-bridge-721", "kintai-bridge", "san-juanico", "6th-october",
  "pont-louis-philippe", "rama-viii", "pont-du-carrousel", "pont-de-sully", "ha-penny", "pont-de-l-archeveche", "el-ferdan-railway", "sanjo-ohashi",
  "ponte-degli-scalzi", "chengyang-yongji", "sami-bridge", "auckland-harbour", "robert-f-kennedy", "aioi-bridge", "great-seto", "chaotianmen-bridge",
  "apollo-bridge", "zhaozhou-bridge", "viaduc-d-austerlitz", "sangarius-bridge", "general-rafael-urdaneta", "adolphe-bridge", "ludendorff-bridge", "kennedy-bridge",
  "incheon-bridge", "vansu-bridge", "sunshine-skyway", "governor-nobre-de-carvalho", "jamaraat-bridge", "banpo-bridge", "yi-sun-sin", "mahatma-gandhi-setu",
  "bridge-of-no-return", "zeeland-bridge", "storseisundet-bridge", "wandsworth-bridge", "padma-bridge", "jamuna-bridge", "amur-bridge", "pont-de-bercy",
  "the-rolling", "saratov-bridge", "bagration-bridge", "lanfranconi-bridge", "pont-de-la-tournelle", "pont-d-arcole", "xihoumen-bridge", "mala-rijeka",
  "yokohama-bay", "tanners-bridge", "lions-gate", "jiangyin-yangtze-river", "gazela-bridge", "mindaugas-bridge", "vincent-thomas", "wiesen-viaduct",
  "bandra-worli-sea-link", "rama-ix", "pont-marie", "pont-amont", "yangpu-bridge", "u-bein", "branko-s", "pont-aval",
  "pont-du-diable", "constantine-s", "charles-kuonen-suspension", "great-bridge-of-hrazdan", "blagoveshchensky-bridge", "market-street", "nanjing-yangtze-river", "kramerbrucke",
  "new-river-gorge", "durdevica-tara", "ponte-santa-trinita", "lions-bridge", "askoy-bridge", "south-stack", "capilano-suspension", "carrick-a-rede-rope",
  "acueducto-de-los-milagros", "kew-bridge", "james-joyce", "pont-charles-de-gaulle", "prince-of-wales", "pancevo-bridge", "vidyasagar-setu", "admiral-s",
  "pont-de-grenelle", "poniatowski-bridge", "fourth-thai-lao-friendship", "pont-de-tolbiac", "washington-bridge", "devil-s", "long-bien", "liteyny-bridge",
  "euphrates-tunnel", "tyne-bridge", "wuhan-yangtze-river", "fehmarn-sound", "golden-horn-metro", "bayonne-bridge", "birchenough-bridge", "malabadi-bridge",
  "manes-bridge", "taskopru", "tabiat-bridge", "cannon-street-railway", "putney-bridge", "egyptian-bridge", "bank-bridge", "chesapeake-bay",
  "hoga-kusten", "benjamin-franklin", "augustus-bridge", "rio-negro", "solkan-bridge", "516-arouca", "queen-elizabeth-ii", "terzi-bridge",
  "eagles-bridge", "ponte-delle-guglie", "stonecutters-bridge", "amizade-bridge", "bhumibol-bridge", "grand-canyon-skywalk", "goteik-viaduct", "katarina-elevator",
  "art-bridge", "pont-rouelle", "queen-louise", "loschwitz-bridge", "pivnichnyi-bridge", "davtashen-bridge", "bolsheokhtinsky-bridge", "krungthep-bridge",
  "puente-de-piedra", "passerelle-debilly", "kanuni-sultan-suleiman", "bolshoy-moskvoretsky", "eurymedon-bridge", "tianjin-grand", "severan-bridge", "stary-most",
  "carioca-aqueduct", "o-connell", "bronx-whitestone", "conwy-suspension", "humen-pearl-river", "kvalsund-bridge", "ponte-delle-tette", "crni-kal",
  "uddevalla-bridge", "helgeland-bridge", "stromsund-bridge", "queensferry-crossing", "saint-nazaire", "rande-bridge", "third-mainland", "qasr-al-nil",
  "seven-mile", "blauwbrug", "murinsel", "zubizuri", "anghel-saligny", "japanese-bridge", "ponte-cavour", "delal-bridge",
  "pupin-bridge", "barton-swing", "grand-duchess-charlotte", "daughters-of-jacob", "pisek-stone", "ponte-della-paglia", "tappan-zee", "champlain-bridge",
  "ava-bridge", "iber-bridge", "sandnessund-bridge", "general-artigas", "koror-babeldaob", "tancredo-neves", "atlantic-bridge", "arslanagic-bridge",
  "faro-bridges", "ponte-nomentano", "precious-belt", "bridge-near-limyra", "abdoun-bridge", "pont-de-pierre", "dr-bhupen-hazarika", "pont-valentre",
  "castelvecchio-bridge", "onaruto-bridge", "tjorn-bridge", "merefa-kherson", "zolotoy-bridge", "langwieser-viaduct", "mathematical-bridge", "replot-bridge",
  "khabarovsk-bridge", "skarnsund-bridge", "salginatobel-bridge", "san-diego-coronado", "streymin-bridge", "sando-bridge", "new-railroad", "langkawi-sky",
  "queen-emma", "pont-de-la-margineda", "dona-ana", "les-ferreres", "muntplein", "garibaldi-bridge", "rosario-victoria", "ponte-umberto-i",
  "tajik-afghan-friendship", "rach-mieu", "kizuna-bridge", "blagoveshchensk-heihe", "sundoy-bridge", "woodrow-wilson", "roosevelt-island", "pivdennyi-bridge",
  "hernando-de-soto", "circle-bridge", "inglisild", "skye-bridge", "arrabida-bridge", "chiswick-bridge", "cize-bolozon", "cumbe-mayo",
  "11-foot-8", "genoa-saint-george", "alvsborg-bridge", "bridge-of-four-lions", "luding-bridge", "halogaland-bridge", "aizhai-bridge", "bear-mountain",
  "baling-river", "tjeldsund-bridge", "old-sotra", "gwangan-bridge", "dumbarton-bridge", "maputo-catembe", "trnovo-bridge", "braila-bridge",
  "hartland-bridge", "ting-kau", "anzac-bridge", "assut-de-l-or", "schlossbrucke", "tsakona-arch", "vasterbron", "mapo-bridge",
  "ongryu-bridge", "sai-van", "bridge-of-arta", "euripus-bridge", "overtoun-bridge", "paski-most", "ponte-palatino", "nelson-mandela",
  "festina-lente", "waibaidu-bridge", "pons-neronianus", "malleco-viaduct", "tokyo-bay-aqua-line", "voroshilovsky-bridge", "kokushkin-bridge", "pont-du-garigliano",
  "alconetar-bridge", "grunwald-bridge", "lotus-bridge", "spean-thma", "hercilio-luz", "jisr-ed-damiye", "tokyo-gate", "lewis-and-clark",
  "mameyand", "asparuhov-most", "hermitage-bridge", "uzunkopru-bridge",
];

// 이름 하나의 마지막 사용 시각(epoch ms). 정리된 서브의 세션 레코드에서 온다.
export type NameUsage = { name: string; lastUsedAt: number };

// 다음에 발급할 이름을 고른다.
//
// 유일성은 살아 있는 자리 셋만 본다 — live(정리 안 된 서브), folders(trees/ 폴더),
// branches(agentbridge/ 브랜치). 이 셋 어디에도 없으면 비어 있는 이름이다.
export function issueBridgeName(args: {
  live: Iterable<string>;
  folders: Iterable<string>;
  branches: Iterable<string>;
  usage: Iterable<NameUsage>;
}): string {
  const occupied = new Set<string>();
  for (const name of args.live) occupied.add(name);
  for (const name of args.folders) occupied.add(name);
  for (const name of args.branches) occupied.add(name);

  // 마지막 사용 시각 — 같은 이름이 이력에 여러 번 나오면 가장 최근 값을 남긴다.
  const lastUsedAt = new Map<string, number>();
  for (const entry of args.usage) {
    const prev = lastUsedAt.get(entry.name);
    if (prev === undefined || entry.lastUsedAt > prev) lastUsedAt.set(entry.name, entry.lastUsedAt);
  }

  const free = BRIDGE_NAMES.filter((name) => !occupied.has(name));

  // 비어 있는 이름 중 한 번도 안 쓴 것이 있으면 목록 순서대로 그것부터 고른다.
  const neverUsed = free.find((name) => !lastUsedAt.has(name));
  if (neverUsed !== undefined) return neverUsed;

  // 전부 쓴 적이 있으면 마지막 사용이 가장 오래된 것부터 — 즉시 재사용하면 같은 이름이
  // 오전과 오후에 다른 서브를 가리켜, 메인이 보고에 적어둔 이름이 나중에 엉뚱한 것을 가리킨다.
  if (free.length > 0) {
    let oldest = free[0];
    let oldestAt = lastUsedAt.get(oldest)!;
    for (const name of free) {
      const at = lastUsedAt.get(name)!;
      if (at < oldestAt) {
        oldest = name;
        oldestAt = at;
      }
    }
    return oldest;
  }

  // 500개가 전부 차 있을 때만 오는 최후 수단. 숫자 접미사도 3면 검사를 통과해야 한다.
  for (let suffix = 2; ; suffix++) {
    for (const base of BRIDGE_NAMES) {
      const candidate = `${base}-${suffix}`;
      if (!occupied.has(candidate)) return candidate;
    }
  }
}
