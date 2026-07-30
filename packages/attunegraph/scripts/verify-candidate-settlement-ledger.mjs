import { strict as assert } from "node:assert";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import * as direct from "../dist/candidate-settlement-ledger.js";

const { CandidateSettlementError, settleCandidateInventory } = direct;
const plain = (value) => JSON.parse(JSON.stringify(value));
const candidate = (consideredAssertions) => ({
  candidateId: "core",
  cost: { assertions: 0, consideredAssertions, depth: 0, estimatedTokens: 0, outputBytes: 0, visitedRefs: 0 },
  preflight: { status: "eligible" },
  rank: 0,
  role: "core",
});
const request = (consideredAssertions, budget = {}) => ({
  budget: { maxAssertions: 0, maxConsideredAssertions: 1_000, maxDepth: 0, maxEstimatedTokens: 1_000_000, maxOutputBytes: 1_000_000, maxVisitedRefs: 0, ...budget },
  core: candidate(consideredAssertions),
  optionals: [],
  schemaVersion: 1,
});

const inventoryCanonicalJson = {
  "9": "{\"budget\":{\"maxAssertions\":0,\"maxConsideredAssertions\":1000,\"maxDepth\":0,\"maxEstimatedTokens\":1000000,\"maxOutputBytes\":1000000,\"maxVisitedRefs\":0},\"core\":{\"candidateId\":\"core\",\"cost\":{\"assertions\":0,\"consideredAssertions\":9,\"depth\":0,\"estimatedTokens\":0,\"outputBytes\":0,\"visitedRefs\":0},\"preflight\":{\"status\":\"eligible\"},\"rank\":0,\"role\":\"core\"},\"inventoryId\":\"attunegraph-candidate-inventory:sha256:5f07c296d0eb9c22e98422dcbcc6a856729109fd3b2c4a4095ab64c3ad10aab6\",\"optionals\":[],\"schemaVersion\":1}",
  "10": "{\"budget\":{\"maxAssertions\":0,\"maxConsideredAssertions\":1000,\"maxDepth\":0,\"maxEstimatedTokens\":1000000,\"maxOutputBytes\":1000000,\"maxVisitedRefs\":0},\"core\":{\"candidateId\":\"core\",\"cost\":{\"assertions\":0,\"consideredAssertions\":10,\"depth\":0,\"estimatedTokens\":0,\"outputBytes\":0,\"visitedRefs\":0},\"preflight\":{\"status\":\"eligible\"},\"rank\":0,\"role\":\"core\"},\"inventoryId\":\"attunegraph-candidate-inventory:sha256:d821e45bdd7c886a6be73eb2a087bbf88cc1600c7e187df5d46db91e4ec0444b\",\"optionals\":[],\"schemaVersion\":1}",
  "99": "{\"budget\":{\"maxAssertions\":0,\"maxConsideredAssertions\":1000,\"maxDepth\":0,\"maxEstimatedTokens\":1000000,\"maxOutputBytes\":1000000,\"maxVisitedRefs\":0},\"core\":{\"candidateId\":\"core\",\"cost\":{\"assertions\":0,\"consideredAssertions\":99,\"depth\":0,\"estimatedTokens\":0,\"outputBytes\":0,\"visitedRefs\":0},\"preflight\":{\"status\":\"eligible\"},\"rank\":0,\"role\":\"core\"},\"inventoryId\":\"attunegraph-candidate-inventory:sha256:9b4c673ac5a1e64f8319b1f8c1d85367bd57336bf2fcc6e295682fe01316294e\",\"optionals\":[],\"schemaVersion\":1}",
  "100": "{\"budget\":{\"maxAssertions\":0,\"maxConsideredAssertions\":1000,\"maxDepth\":0,\"maxEstimatedTokens\":1000000,\"maxOutputBytes\":1000000,\"maxVisitedRefs\":0},\"core\":{\"candidateId\":\"core\",\"cost\":{\"assertions\":0,\"consideredAssertions\":100,\"depth\":0,\"estimatedTokens\":0,\"outputBytes\":0,\"visitedRefs\":0},\"preflight\":{\"status\":\"eligible\"},\"rank\":0,\"role\":\"core\"},\"inventoryId\":\"attunegraph-candidate-inventory:sha256:72b5f74c65985873714819006c1236bb5a860378ce23c3309d451259befbc528\",\"optionals\":[],\"schemaVersion\":1}"
};
const baseCanonicalJson = {
  "9": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":9,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"attunegraph-candidate-inventory:sha256:5f07c296d0eb9c22e98422dcbcc6a856729109fd3b2c4a4095ab64c3ad10aab6\",\"ledgerId\":\"attunegraph-candidate-ledger:sha256:19c03509df9fc34aae8f7b0f980e25416a3488a2fc7fef057d0e61c2fc6a7a87\",\"mode\":\"normal\",\"schemaVersion\":1}",
  "10": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":10,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"attunegraph-candidate-inventory:sha256:d821e45bdd7c886a6be73eb2a087bbf88cc1600c7e187df5d46db91e4ec0444b\",\"ledgerId\":\"attunegraph-candidate-ledger:sha256:97576f97583da8a67af7c3b81b7b4dc506310016f479ce19afeb56f8a083dc88\",\"mode\":\"normal\",\"schemaVersion\":1}",
  "99": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":99,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"attunegraph-candidate-inventory:sha256:9b4c673ac5a1e64f8319b1f8c1d85367bd57336bf2fcc6e295682fe01316294e\",\"ledgerId\":\"attunegraph-candidate-ledger:sha256:ecefd36645e1a29bd2b67008da1254b810c5570c6c715e7c69ecdcfbc655ab79\",\"mode\":\"normal\",\"schemaVersion\":1}",
  "100": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":100,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"attunegraph-candidate-inventory:sha256:72b5f74c65985873714819006c1236bb5a860378ce23c3309d451259befbc528\",\"ledgerId\":\"attunegraph-candidate-ledger:sha256:45f9f038e706108bd07e15080e92bd8da6e3e5e8f2f7cfea6c450b84e481c483\",\"mode\":\"normal\",\"schemaVersion\":1}"
};
const capacityCanonicalJson = {
  "9": {
    "bytes-under": "{\"errorId\":\"attunegraph-candidate-capacity-error:sha256:d102084eca6e161ce2074bc8adea084e991ce733138f5c972b88418ccdc260c7\",\"firstViolatedAxis\":\"bytes\",\"inventoryId\":\"attunegraph-candidate-inventory:sha256:caad3bbc47872f66564b7b1a94179ce63f0de63d01a7fe67d7ae82dfb53e3d02\",\"minimumRequired\":{\"maxEstimatedTokens\":158,\"maxOutputBytes\":629},\"mode\":\"invalid-input\",\"reasonId\":\"minimum-abstention-exceeds-budget\",\"schemaVersion\":1}",
    "bytes-exact": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":9,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"attunegraph-candidate-inventory:sha256:99f5c4f242583d3f30a26031260684b22f5f3093ab24fcb3b18bd5cff6abf954\",\"ledgerId\":\"attunegraph-candidate-ledger:sha256:f0b8f9e41ad9a0ae3fa5c6f58c2e9de14bf2f09341e2bb0e29e511d20baac009\",\"mode\":\"normal\",\"schemaVersion\":1}",
    "bytes-over": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":9,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"attunegraph-candidate-inventory:sha256:1c4be76c52cfd54a63298b9fcfc017f942a7c936a2f6388356dcee0c3375f282\",\"ledgerId\":\"attunegraph-candidate-ledger:sha256:d45c42aeca554c8a5657df8ae005a02ab5d6d2fbed933bf81b983788a1ad24b8\",\"mode\":\"normal\",\"schemaVersion\":1}",
    "token-under": "{\"errorId\":\"attunegraph-candidate-capacity-error:sha256:185f6f3377bded4436807e22eb370371472fc69db663c2eadfc2142d87156e34\",\"firstViolatedAxis\":\"token\",\"inventoryId\":\"attunegraph-candidate-inventory:sha256:ac4300b24f8d81164a25d4211ab709022807295761685e933188cef8f672cb5c\",\"minimumRequired\":{\"maxEstimatedTokens\":158,\"maxOutputBytes\":629},\"mode\":\"invalid-input\",\"reasonId\":\"minimum-abstention-exceeds-budget\",\"schemaVersion\":1}",
    "token-exact": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":9,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"attunegraph-candidate-inventory:sha256:514288510162557529592c62f8e7f798634fff83236fb8e73be1c485c7995cc2\",\"ledgerId\":\"attunegraph-candidate-ledger:sha256:f5dd0d744af0f37158c82b591880b794e7c1ea3cfefd0fe93596d8005e4db135\",\"mode\":\"normal\",\"schemaVersion\":1}",
    "token-over": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":9,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"attunegraph-candidate-inventory:sha256:53de3d950c82dbcf887788c58ccba1548fcac4a5e224fba193dbe3a1122ebb2c\",\"ledgerId\":\"attunegraph-candidate-ledger:sha256:fbde9eb814e5adc306bcaff619751e052425bfe6b3d0f3e2cb159e4d8ebbd7b9\",\"mode\":\"normal\",\"schemaVersion\":1}"
  },
  "10": {
    "bytes-under": "{\"errorId\":\"attunegraph-candidate-capacity-error:sha256:1f68ac551ffebc13d3a0d38ef8bfa50b1f0c3240a17c159345924fcb9e02e904\",\"firstViolatedAxis\":\"bytes\",\"inventoryId\":\"attunegraph-candidate-inventory:sha256:269bf2a2d2654a9f1bf2d7bffc227ba9d0793200e86150d9fdaad6eb6736f9e2\",\"minimumRequired\":{\"maxEstimatedTokens\":158,\"maxOutputBytes\":629},\"mode\":\"invalid-input\",\"reasonId\":\"minimum-abstention-exceeds-budget\",\"schemaVersion\":1}",
    "bytes-exact": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":10,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"attunegraph-candidate-inventory:sha256:9e1ed460ca8df680a308df4160318c76ab6b0a6d65b9b13d338859cce3475f6e\",\"ledgerId\":\"attunegraph-candidate-ledger:sha256:4cdc220422ebe3eaca9fa223a18bb7f8295a4ee34ed79df7c70fa85aa3d2c914\",\"mode\":\"normal\",\"schemaVersion\":1}",
    "bytes-over": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":10,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"attunegraph-candidate-inventory:sha256:78dc794b77631992bf7ef0f399781b70ea79b2626ff207663ba9d1df998de683\",\"ledgerId\":\"attunegraph-candidate-ledger:sha256:3e2bff727663da2cf7a3262663b7bd6564979e340c2c28ce7eb21a1661b7adc8\",\"mode\":\"normal\",\"schemaVersion\":1}",
    "token-under": "{\"errorId\":\"attunegraph-candidate-capacity-error:sha256:ec197adab86c520c1e813c82579514d955b38a4459f7931fde8075484c100be1\",\"firstViolatedAxis\":\"token\",\"inventoryId\":\"attunegraph-candidate-inventory:sha256:1804288233f2f677fba041e3e63e6804c9b9615db97da25ca7a0de92d8c4f39f\",\"minimumRequired\":{\"maxEstimatedTokens\":158,\"maxOutputBytes\":629},\"mode\":\"invalid-input\",\"reasonId\":\"minimum-abstention-exceeds-budget\",\"schemaVersion\":1}",
    "token-exact": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":10,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"attunegraph-candidate-inventory:sha256:2126c78bfd43853027a0d3f386ee174af20ee4e040375327164376a39938c73d\",\"ledgerId\":\"attunegraph-candidate-ledger:sha256:6e953f5a56670561f7b9c4858ce6f25f3b2dbe97bab48caef8ee118733f9d24e\",\"mode\":\"normal\",\"schemaVersion\":1}",
    "token-over": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":10,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"attunegraph-candidate-inventory:sha256:db3156b0cb5fc5a1611e0c955930f914f7ab7eeb8fd86ac3ca4a9c42115f83be\",\"ledgerId\":\"attunegraph-candidate-ledger:sha256:94b579f4ddfe834464aefaf10d07acbf89849d0a9deb7e40322698f3a809e5f1\",\"mode\":\"normal\",\"schemaVersion\":1}"
  },
  "99": {
    "bytes-under": "{\"errorId\":\"attunegraph-candidate-capacity-error:sha256:9048f0ffe31e87c18617017df6895559aff128bda474a53e29a57fb60fd5b48e\",\"firstViolatedAxis\":\"bytes\",\"inventoryId\":\"attunegraph-candidate-inventory:sha256:6f4e257e2f97765d2be8e32e789f2c28577db2d84069356d20dc52c472ece5b3\",\"minimumRequired\":{\"maxEstimatedTokens\":158,\"maxOutputBytes\":629},\"mode\":\"invalid-input\",\"reasonId\":\"minimum-abstention-exceeds-budget\",\"schemaVersion\":1}",
    "bytes-exact": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":99,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"attunegraph-candidate-inventory:sha256:38065a779a34e0b1f5bca6ad2c410cd0f9056ecbdabf5ccd7005a025d049e513\",\"ledgerId\":\"attunegraph-candidate-ledger:sha256:8ee9ee878cb27bad80025a559b359835c36c7938b4c05638eaff0fcaf60b9d92\",\"mode\":\"normal\",\"schemaVersion\":1}",
    "bytes-over": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":99,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"attunegraph-candidate-inventory:sha256:de8706c3e04284dc9abd8297aaaa41c10a600f37cba8b9711305997cd7209e23\",\"ledgerId\":\"attunegraph-candidate-ledger:sha256:30e54dd56840bd6edab0998f75d2a72efe828dd84fb31fb9b932d8e050ab147b\",\"mode\":\"normal\",\"schemaVersion\":1}",
    "token-under": "{\"errorId\":\"attunegraph-candidate-capacity-error:sha256:5cef3bf783fb9b135999ee9b9345720eefb6c5584227828e963c6f7c6dc26a3a\",\"firstViolatedAxis\":\"token\",\"inventoryId\":\"attunegraph-candidate-inventory:sha256:b29a7e1534622ddd82d7c49718c99ba24482f12c763b76c5445c619a0cd9fb8d\",\"minimumRequired\":{\"maxEstimatedTokens\":158,\"maxOutputBytes\":629},\"mode\":\"invalid-input\",\"reasonId\":\"minimum-abstention-exceeds-budget\",\"schemaVersion\":1}",
    "token-exact": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":99,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"attunegraph-candidate-inventory:sha256:e26390de88cf681caa52f3bf9c1fa49572fb0f26c11ea60f5f64cba47b383c45\",\"ledgerId\":\"attunegraph-candidate-ledger:sha256:72d7ddcba5839978b5f76bb17d7bce1b594c6f8318c41be0775f91c92940d7b8\",\"mode\":\"normal\",\"schemaVersion\":1}",
    "token-over": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":99,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"attunegraph-candidate-inventory:sha256:7c46dc989b7746bcb2cdd4d3d0e3865a3d5f5fa3d983526728a6dad3ce8feb89\",\"ledgerId\":\"attunegraph-candidate-ledger:sha256:84c24359c1b4c580e169ab1e6ac0ed8e7113a58d82c8b4cce32c6e6fe834737c\",\"mode\":\"normal\",\"schemaVersion\":1}"
  },
  "100": {
    "bytes-under": "{\"errorId\":\"attunegraph-candidate-capacity-error:sha256:110b7aa22948458e6b999c2ebb29c3f814135bdd69db1a552f9c31a013881d5c\",\"firstViolatedAxis\":\"bytes\",\"inventoryId\":\"attunegraph-candidate-inventory:sha256:00085dd1e9646a6a491c4bf3c1f324f0eb05f879ba75329393595c7489ce71d2\",\"minimumRequired\":{\"maxEstimatedTokens\":158,\"maxOutputBytes\":629},\"mode\":\"invalid-input\",\"reasonId\":\"minimum-abstention-exceeds-budget\",\"schemaVersion\":1}",
    "bytes-exact": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":100,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"attunegraph-candidate-inventory:sha256:4d4d93fcff6081aa23ed63cdd408e9b8549501ea3cf82f97d1a344f1899af45e\",\"ledgerId\":\"attunegraph-candidate-ledger:sha256:f202a4fff5580cbeb8c6c0c5881869761e9b0b1476e0c7698248cedcc8c52fb6\",\"mode\":\"normal\",\"schemaVersion\":1}",
    "bytes-over": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":100,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"attunegraph-candidate-inventory:sha256:81def62d8a29e62addc330da4a1a222641ad0b516648e9b93584aaa5cfd10b65\",\"ledgerId\":\"attunegraph-candidate-ledger:sha256:1844e19afa339c64d70b2a467d5324557536bfb9c26b432179203459927ee090\",\"mode\":\"normal\",\"schemaVersion\":1}",
    "token-under": "{\"errorId\":\"attunegraph-candidate-capacity-error:sha256:a016d2e19b88081a11bd0cf2aa0ee7bdaad7f742b6d6f60d6c8e39bdb13d58fa\",\"firstViolatedAxis\":\"token\",\"inventoryId\":\"attunegraph-candidate-inventory:sha256:b744702e4633bd4758dd9815358997940eccffd8cfaac13914b95c78c181ee7c\",\"minimumRequired\":{\"maxEstimatedTokens\":158,\"maxOutputBytes\":629},\"mode\":\"invalid-input\",\"reasonId\":\"minimum-abstention-exceeds-budget\",\"schemaVersion\":1}",
    "token-exact": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":100,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"attunegraph-candidate-inventory:sha256:40e7e1d41f09136df9866536083625094bf0672a53c0d6a40cf8b59282a46712\",\"ledgerId\":\"attunegraph-candidate-ledger:sha256:9a071826ecb4efee6a518f9542d1c5dfedab26de10f6a6fe515f64399da0fbd4\",\"mode\":\"normal\",\"schemaVersion\":1}",
    "token-over": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":100,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"attunegraph-candidate-inventory:sha256:2d8409e594640b4da07c8f8517783790272b9f0b547c716ea5dccc1745d5b564\",\"ledgerId\":\"attunegraph-candidate-ledger:sha256:38f995c6456646228d67b32aeecebb1ab1e75293419ea20b06ce4540948c5ce5\",\"mode\":\"normal\",\"schemaVersion\":1}"
  }
};
const capacityVariantDiscriminants = {
  "bytes-under": "invalid-input",
  "bytes-exact": "settled",
  "bytes-over": "settled",
  "token-under": "invalid-input",
  "token-exact": "settled",
  "token-over": "settled"
};
const baseMetadata = {
  "9": {
    "bytes": 563,
    "estimatedTokens": 141,
    "id": "attunegraph-candidate-ledger:sha256:19c03509df9fc34aae8f7b0f980e25416a3488a2fc7fef057d0e61c2fc6a7a87",
    "totalOutputBytes": 563
  },
  "10": {
    "bytes": 564,
    "estimatedTokens": 141,
    "id": "attunegraph-candidate-ledger:sha256:97576f97583da8a67af7c3b81b7b4dc506310016f479ce19afeb56f8a083dc88",
    "totalOutputBytes": 564
  },
  "99": {
    "bytes": 564,
    "estimatedTokens": 141,
    "id": "attunegraph-candidate-ledger:sha256:ecefd36645e1a29bd2b67008da1254b810c5570c6c715e7c69ecdcfbc655ab79",
    "totalOutputBytes": 564
  },
  "100": {
    "bytes": 565,
    "estimatedTokens": 142,
    "id": "attunegraph-candidate-ledger:sha256:45f9f038e706108bd07e15080e92bd8da6e3e5e8f2f7cfea6c450b84e481c483",
    "totalOutputBytes": 565
  }
};

function verifyLiteral(canonicalJson, domain, idField, prefix) {
  assert.equal(Buffer.byteLength(canonicalJson), canonicalJson.length);
  const parsed = JSON.parse(canonicalJson);
  const contentId = parsed[idField];
  delete parsed[idField];
  const digest = createHash("sha256").update(`${domain}\0${JSON.stringify(parsed)}`).digest("hex");
  assert.equal(contentId, `${prefix}${digest}`);
  return JSON.parse(canonicalJson);
}

for (const considered of [9, 10, 99, 100]) {
  const inventory = verifyLiteral(inventoryCanonicalJson[considered], "attunegraph.candidate-inventory.v1", "inventoryId", "attunegraph-candidate-inventory:sha256:");
  const expectedBase = verifyLiteral(baseCanonicalJson[considered], "attunegraph.candidate-settlement-ledger.v1", "ledgerId", "attunegraph-candidate-ledger:sha256:");
  const base = settleCandidateInventory(request(considered));
  assert.equal(base.status, "settled");
  assert.equal(base.ledger.mode, "normal");
  assert.equal(base.canonicalJson, baseCanonicalJson[considered]);
  assert.equal(base.canonicalByteLength, baseMetadata[considered].bytes);
  assert.equal(base.totalOutputBytes, baseMetadata[considered].totalOutputBytes);
  assert.equal(base.estimatedTokens, baseMetadata[considered].estimatedTokens);
  assert.equal(base.ledger.ledgerId, baseMetadata[considered].id);
  assert.equal(base.ledger.inventoryId, inventory.inventoryId);
  assert.deepEqual(plain(base.ledger), expectedBase);
  const q = Math.ceil(baseMetadata[considered].bytes / 4);
  const variants = {
    "bytes-under": { maxEstimatedTokens: 1_000_000, maxOutputBytes: baseMetadata[considered].bytes - 1 },
    "bytes-exact": { maxEstimatedTokens: 1_000_000, maxOutputBytes: baseMetadata[considered].bytes },
    "bytes-over": { maxEstimatedTokens: 1_000_000, maxOutputBytes: baseMetadata[considered].bytes + 1 },
    "token-under": { maxEstimatedTokens: q - 1, maxOutputBytes: 1_000_000 },
    "token-exact": { maxEstimatedTokens: q, maxOutputBytes: 1_000_000 },
    "token-over": { maxEstimatedTokens: q + 1, maxOutputBytes: 1_000_000 },
  };
  for (const [name, budget] of Object.entries(variants)) {
    const actual = settleCandidateInventory(request(considered, budget));
    const canonicalJson = capacityCanonicalJson[considered][name];
    const expectedEnvelope = JSON.parse(canonicalJson);
    const invalid = expectedEnvelope.mode === "invalid-input";
    const verified = verifyLiteral(
      canonicalJson,
      invalid ? "attunegraph.candidate-settlement-capacity-error.v1" : "attunegraph.candidate-settlement-ledger.v1",
      invalid ? "errorId" : "ledgerId",
      invalid ? "attunegraph-candidate-capacity-error:sha256:" : "attunegraph-candidate-ledger:sha256:",
    );
    assert.equal(actual.status, capacityVariantDiscriminants[name]);
    assert.equal(actual.status, invalid ? "invalid-input" : "settled");
    assert.equal(actual.canonicalJson, canonicalJson);
    assert.equal(actual.canonicalByteLength, Buffer.byteLength(canonicalJson));
    if (actual.status === "settled") {
      assert.equal(actual.ledger.mode, "normal");
      assert.deepEqual(plain(actual.ledger), verified);
      assert.equal(actual.totalOutputBytes, baseMetadata[considered].totalOutputBytes);
      assert.equal(actual.estimatedTokens, baseMetadata[considered].estimatedTokens);
      assert.deepEqual(plain(actual.ledger.entries), [{ candidateId: "core", role: "core", terminalState: "admitted" }]);
      assert.deepEqual(plain(actual.ledger.counters), expectedEnvelope.counters);
    } else {
      assert.deepEqual(plain(actual.error), verified);
      assert.deepEqual(plain(actual.error.minimumRequired), { maxEstimatedTokens: 158, maxOutputBytes: 629 });
      assert.equal(actual.error.firstViolatedAxis, name.startsWith("bytes") ? "bytes" : "token");
    }
  }
}

function expectPrivateError(value, reason, path) {
  assert.throws(
    () => settleCandidateInventory(value),
    (error) => {
      assert(error instanceof CandidateSettlementError);
      assert.equal(error.name, "CandidateSettlementError");
      assert.equal(error.code, "INVALID_REQUEST");
      assert.deepEqual(error.details, { path, reason });
      assert(Object.isFrozen(error.details));
      return true;
    },
  );
}

expectPrivateError({ ...request(0), core: candidate(0), extra: true }, "invalid-field-set", "");
expectPrivateError({ ...request(0), core: { ...candidate(0), candidateId: "BAD" } }, "invalid-candidate-id", "/core/candidateId");
expectPrivateError({ ...request(0), optionals: [{ ...candidate(0), candidateId: "core", role: "optional" }] }, "duplicate-candidate-id", "/optionals/0/candidateId");
expectPrivateError({ ...request(0), core: { ...candidate(0), preflight: { extra: true, status: "bogus" } } }, "invalid-field-set", "/core/preflight");

let getterCalls = 0;
const accessor = request(0);
Object.defineProperty(accessor.core, "candidateId", { enumerable: true, get() { getterCalls += 1; return "core"; } });
assert.throws(
  () => settleCandidateInventory(accessor),
  (error) => error.constructor.name === "CanonicalImmutableEnvelopeError"
    && error.code === "INVALID_INPUT"
    && error.details.phase === "inspect"
    && error.details.reason === "accessor-or-missing-descriptor"
    && error.details.path === "/core/candidateId",
);
assert.equal(getterCalls, 0);
const alias = request(0);
alias.optionals = [alias.core];
assert.throws(
  () => settleCandidateInventory(alias),
  (error) => error.constructor.name === "CanonicalImmutableEnvelopeError"
    && error.code === "INVALID_INPUT"
    && error.details.phase === "inspect"
    && error.details.reason === "alias"
    && error.details.path === "/optionals/0",
);
let proxyTraps = 0;
const proxy = new Proxy(request(0), {
  getOwnPropertyDescriptor() { proxyTraps += 1; throw new Error("must not execute"); },
  ownKeys() { proxyTraps += 1; throw new Error("must not execute"); },
});
assert.throws(
  () => settleCandidateInventory(proxy),
  (error) => error.constructor.name === "CanonicalImmutableEnvelopeError"
    && error.code === "INVALID_INPUT"
    && error.details.phase === "inspect"
    && error.details.reason === "proxy"
    && error.details.path === "",
);
assert.equal(proxyTraps, 0);

assert.deepEqual(Object.keys(direct).sort(), ["CandidateSettlementError", "settleCandidateInventory"]);
const root = await import("@attunegraph/core");
assert.deepEqual(Object.keys(root).sort(), [
  "ACTIVATION_PREDICATES",
  "AttuneGraphDataError",
  "AttuneGraphError",
  "GRAPH_ASSERTION_SOURCE_NAMESPACE",
  "GRAPH_DERIVATION_KINDS",
  "GRAPH_DIRECTIONS",
  "GRAPH_EPISTEMIC_CLASSES",
  "GRAPH_NODE_KINDS",
  "GRAPH_PREDICATES",
  "InMemoryAttuneGraphDataStore",
  "MAX_ACTIVATION_ESTIMATED_TOKENS",
  "MAX_GRAPH_APPEND_BATCH_ASSERTIONS",
  "MAX_GRAPH_ASSERTION_SOURCE_REFS",
  "MAX_GRAPH_QUERY_ASSERTIONS",
  "MAX_GRAPH_QUERY_CONSIDERED_ASSERTIONS",
  "MAX_GRAPH_QUERY_DEPTH",
  "MAX_GRAPH_QUERY_SEEDS",
  "MAX_GRAPH_QUERY_VISITED_REFS",
  "compileActivationSubgraph",
  "createAttuneGraphEngine",
  "openAttuneGraph",
]);
await assert.rejects(import("@attunegraph/core/candidate-settlement-ledger"), (error) => error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED");
