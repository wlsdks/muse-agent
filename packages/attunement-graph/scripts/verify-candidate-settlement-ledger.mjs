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
  9: "{\"budget\":{\"maxAssertions\":0,\"maxConsideredAssertions\":1000,\"maxDepth\":0,\"maxEstimatedTokens\":1000000,\"maxOutputBytes\":1000000,\"maxVisitedRefs\":0},\"core\":{\"candidateId\":\"core\",\"cost\":{\"assertions\":0,\"consideredAssertions\":9,\"depth\":0,\"estimatedTokens\":0,\"outputBytes\":0,\"visitedRefs\":0},\"preflight\":{\"status\":\"eligible\"},\"rank\":0,\"role\":\"core\"},\"inventoryId\":\"muse-candidate-inventory:sha256:ccfabaa861bce1ac18cd540f6e39ecc639a3447d6cd480d5e519a3ae4ea18fd7\",\"optionals\":[],\"schemaVersion\":1}",
  10: "{\"budget\":{\"maxAssertions\":0,\"maxConsideredAssertions\":1000,\"maxDepth\":0,\"maxEstimatedTokens\":1000000,\"maxOutputBytes\":1000000,\"maxVisitedRefs\":0},\"core\":{\"candidateId\":\"core\",\"cost\":{\"assertions\":0,\"consideredAssertions\":10,\"depth\":0,\"estimatedTokens\":0,\"outputBytes\":0,\"visitedRefs\":0},\"preflight\":{\"status\":\"eligible\"},\"rank\":0,\"role\":\"core\"},\"inventoryId\":\"muse-candidate-inventory:sha256:e0c3989c3b3342ea2e7e93bd56826faea635df4feaaccd74144a30ad12cd85bc\",\"optionals\":[],\"schemaVersion\":1}",
  99: "{\"budget\":{\"maxAssertions\":0,\"maxConsideredAssertions\":1000,\"maxDepth\":0,\"maxEstimatedTokens\":1000000,\"maxOutputBytes\":1000000,\"maxVisitedRefs\":0},\"core\":{\"candidateId\":\"core\",\"cost\":{\"assertions\":0,\"consideredAssertions\":99,\"depth\":0,\"estimatedTokens\":0,\"outputBytes\":0,\"visitedRefs\":0},\"preflight\":{\"status\":\"eligible\"},\"rank\":0,\"role\":\"core\"},\"inventoryId\":\"muse-candidate-inventory:sha256:59999f9b21c5438483d1535cce93dcbb6d09d9e81b64d9bd08836f0cd77e8095\",\"optionals\":[],\"schemaVersion\":1}",
  100: "{\"budget\":{\"maxAssertions\":0,\"maxConsideredAssertions\":1000,\"maxDepth\":0,\"maxEstimatedTokens\":1000000,\"maxOutputBytes\":1000000,\"maxVisitedRefs\":0},\"core\":{\"candidateId\":\"core\",\"cost\":{\"assertions\":0,\"consideredAssertions\":100,\"depth\":0,\"estimatedTokens\":0,\"outputBytes\":0,\"visitedRefs\":0},\"preflight\":{\"status\":\"eligible\"},\"rank\":0,\"role\":\"core\"},\"inventoryId\":\"muse-candidate-inventory:sha256:3836d4080dccd61d3df7623992a4328dd4f14fc27ae8d68d9425e31de1f27d21\",\"optionals\":[],\"schemaVersion\":1}",
};
const baseCanonicalJson = {
  9: "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":9,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"muse-candidate-inventory:sha256:ccfabaa861bce1ac18cd540f6e39ecc639a3447d6cd480d5e519a3ae4ea18fd7\",\"ledgerId\":\"muse-candidate-ledger:sha256:906e670c57d9dd5ce87d226e0345b1ddfd183cf172d25a351b0618eb7088c07c\",\"mode\":\"normal\",\"schemaVersion\":1}",
  10: "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":10,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"muse-candidate-inventory:sha256:e0c3989c3b3342ea2e7e93bd56826faea635df4feaaccd74144a30ad12cd85bc\",\"ledgerId\":\"muse-candidate-ledger:sha256:ba191fce935dc2ebafff1c61b48354d149a1016a52de667424da64246c0157c8\",\"mode\":\"normal\",\"schemaVersion\":1}",
  99: "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":99,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"muse-candidate-inventory:sha256:59999f9b21c5438483d1535cce93dcbb6d09d9e81b64d9bd08836f0cd77e8095\",\"ledgerId\":\"muse-candidate-ledger:sha256:6a31fc757254ac4c107729dca474cf5612cd1ca482dc6d2d9e21ce79f0bd5e33\",\"mode\":\"normal\",\"schemaVersion\":1}",
  100: "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":100,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"muse-candidate-inventory:sha256:3836d4080dccd61d3df7623992a4328dd4f14fc27ae8d68d9425e31de1f27d21\",\"ledgerId\":\"muse-candidate-ledger:sha256:df29dbaee42c16bee4d2f7c836210df5ecf8f8e69aadd49a9d8d1f0386da57d0\",\"mode\":\"normal\",\"schemaVersion\":1}",
};
const capacityCanonicalJson = {
  9: {
    "bytes-under": "{\"errorId\":\"muse-candidate-capacity-error:sha256:eae8062316f57cc8b391258dfdab752aa6d9a17149ef30455792c780730969a3\",\"firstViolatedAxis\":\"bytes\",\"inventoryId\":\"muse-candidate-inventory:sha256:3d17b2a90fe7d5e3f18b12d5552b4b79fe1fb7fb5436d6e127769de86f0868ae\",\"minimumRequired\":{\"maxEstimatedTokens\":154,\"maxOutputBytes\":615},\"mode\":\"invalid-input\",\"reasonId\":\"minimum-abstention-exceeds-budget\",\"schemaVersion\":1}",
    "bytes-exact": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":9,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"muse-candidate-inventory:sha256:3f77f6bd57ee68dd0b7cf3b0d58ead3341f343288acc7a52adde04167b6a1ef3\",\"ledgerId\":\"muse-candidate-ledger:sha256:2db0f938a76f71740ec511848b289917462565136e31a0d7c8c41d1293fd5d8e\",\"mode\":\"normal\",\"schemaVersion\":1}",
    "bytes-over": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":9,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"muse-candidate-inventory:sha256:de9b669d4be5db75c5884198c76d6588373eaf21e5ed9da4122d954ee624b1df\",\"ledgerId\":\"muse-candidate-ledger:sha256:dd98e632d212e5426ec850cadcd82b6bd4e87fd54b545d3f64d215146d0376c4\",\"mode\":\"normal\",\"schemaVersion\":1}",
    "token-under": "{\"errorId\":\"muse-candidate-capacity-error:sha256:a05b3e143dcb0048b49618034ae78675b11671525620e69ff4a8940ae1d943a2\",\"firstViolatedAxis\":\"token\",\"inventoryId\":\"muse-candidate-inventory:sha256:383f7e5f0e3a867ef88bcb288efe4cbe459bf49b92889ec6709bdd9305dd08ae\",\"minimumRequired\":{\"maxEstimatedTokens\":154,\"maxOutputBytes\":615},\"mode\":\"invalid-input\",\"reasonId\":\"minimum-abstention-exceeds-budget\",\"schemaVersion\":1}",
    "token-exact": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":9,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"muse-candidate-inventory:sha256:3f3f663eaa4c510705d5a879df2acfe5464aab69681b4b415eb9b861143c6855\",\"ledgerId\":\"muse-candidate-ledger:sha256:5567e9e68981d376cc67ab8a7ad653620e7b719109697ce704b0e76d3bcf1272\",\"mode\":\"normal\",\"schemaVersion\":1}",
    "token-over": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":9,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"muse-candidate-inventory:sha256:f9e76694eff5421483e6c2778571df1b26d9571dee5391d128763fe543f71297\",\"ledgerId\":\"muse-candidate-ledger:sha256:027464be440a78f60156c25131f61e4d0f0e38ae134614a64c26b9c9ae35773c\",\"mode\":\"normal\",\"schemaVersion\":1}",
  },
  10: {
    "bytes-under": "{\"errorId\":\"muse-candidate-capacity-error:sha256:a8b267d5dcc60fd33fe56b9a14fd848d37a63c91cd065205b160a92f68e936e8\",\"firstViolatedAxis\":\"bytes\",\"inventoryId\":\"muse-candidate-inventory:sha256:817f60c73a157065dc9a7e6d6ae3a2d6fef07ab536074984650327f39c76e920\",\"minimumRequired\":{\"maxEstimatedTokens\":154,\"maxOutputBytes\":615},\"mode\":\"invalid-input\",\"reasonId\":\"minimum-abstention-exceeds-budget\",\"schemaVersion\":1}",
    "bytes-exact": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":10,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"muse-candidate-inventory:sha256:8a2b1926ffb6323080fea5eb4fcfdad260b284765c23677e11d49da47b5b3238\",\"ledgerId\":\"muse-candidate-ledger:sha256:8e7d376c131f0a7e2c549d4359b202c3f4dc33a127a1068bc6db0598d3a6e81d\",\"mode\":\"normal\",\"schemaVersion\":1}",
    "bytes-over": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":10,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"muse-candidate-inventory:sha256:97e59aa5c0046d00beffc3b1052f2d764cf13bd43a6004de6509f4bc6dd82b70\",\"ledgerId\":\"muse-candidate-ledger:sha256:509d22237dd4e4bd16bacfe739bf38689045651ecf9de5b24a4525d40baa319a\",\"mode\":\"normal\",\"schemaVersion\":1}",
    "token-under": "{\"errorId\":\"muse-candidate-capacity-error:sha256:a93ca6c6c741a9fba130a5feab3398f5f806db9fd8c3d50d75e12888f2e8aea8\",\"firstViolatedAxis\":\"token\",\"inventoryId\":\"muse-candidate-inventory:sha256:ccf4067cff3d3ceecae6fa068bcaa518e8e476fbeb30f4ee25fe87a29df44dc2\",\"minimumRequired\":{\"maxEstimatedTokens\":154,\"maxOutputBytes\":615},\"mode\":\"invalid-input\",\"reasonId\":\"minimum-abstention-exceeds-budget\",\"schemaVersion\":1}",
    "token-exact": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":10,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"muse-candidate-inventory:sha256:87f4b17119b615afb61c563851086794c3dacba7528fee3368aa5e6cb2d0171a\",\"ledgerId\":\"muse-candidate-ledger:sha256:c90964c38c5910803bc279edcf141ced307a45d90470afda587c343e8bdfd19c\",\"mode\":\"normal\",\"schemaVersion\":1}",
    "token-over": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":10,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"muse-candidate-inventory:sha256:672603ec7ca83bde07612e908aa7754df97ab9632fb999f869770d90d0a784e4\",\"ledgerId\":\"muse-candidate-ledger:sha256:2dca61ef2303cfc21cbf2dc5ea50e68f901572954964ccdcd71daad1ea97125a\",\"mode\":\"normal\",\"schemaVersion\":1}",
  },
  99: {
    "bytes-under": "{\"errorId\":\"muse-candidate-capacity-error:sha256:55867259e115418047f26b54ea67a31560c8e54c67490c83db93a54caeff7fcc\",\"firstViolatedAxis\":\"bytes\",\"inventoryId\":\"muse-candidate-inventory:sha256:5183058fd804f712fb707df4c6d8a05936969996a08637b8e819d1a26b3f9b1a\",\"minimumRequired\":{\"maxEstimatedTokens\":154,\"maxOutputBytes\":615},\"mode\":\"invalid-input\",\"reasonId\":\"minimum-abstention-exceeds-budget\",\"schemaVersion\":1}",
    "bytes-exact": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":99,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"muse-candidate-inventory:sha256:091a11cf5929ff8efbe6d18cfb399618f8c1c05b26b2d3c6906e63a0f35226a7\",\"ledgerId\":\"muse-candidate-ledger:sha256:a27d43c48fc8479a8e1ef2c6bc02672ecc415453a3f61fbf786bd26d9783b638\",\"mode\":\"normal\",\"schemaVersion\":1}",
    "bytes-over": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":99,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"muse-candidate-inventory:sha256:d022dd7b078a19d64a2196c7cb3506bb4cd549996b3a6626b7f98ec6df0b4763\",\"ledgerId\":\"muse-candidate-ledger:sha256:acd7008cfd78d48a5bf4f85ef747e44abc94b367b829c186f9dc7d46848e85e3\",\"mode\":\"normal\",\"schemaVersion\":1}",
    "token-under": "{\"errorId\":\"muse-candidate-capacity-error:sha256:114828d27ee1566f59ad09db44f512803558d033d402ef43038ba42d6468b099\",\"firstViolatedAxis\":\"token\",\"inventoryId\":\"muse-candidate-inventory:sha256:5c642b2716c9ce0d7d25e6739d59a6d224c2ddc560912a53523639ff539e2edb\",\"minimumRequired\":{\"maxEstimatedTokens\":154,\"maxOutputBytes\":615},\"mode\":\"invalid-input\",\"reasonId\":\"minimum-abstention-exceeds-budget\",\"schemaVersion\":1}",
    "token-exact": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":99,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"muse-candidate-inventory:sha256:ce08b69856b722c45e30b7c73c7919aac69e5952d8d28c411efd4dbe98991829\",\"ledgerId\":\"muse-candidate-ledger:sha256:f6f39e143cad99b45f88806457b1cce8a0c938ba4c5746d2bfd4bad82a137f07\",\"mode\":\"normal\",\"schemaVersion\":1}",
    "token-over": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":99,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"muse-candidate-inventory:sha256:8691bcb74cf2f221567a1a4bfc156a54157e9eb1d70fcae5e991c923c2ca1d5f\",\"ledgerId\":\"muse-candidate-ledger:sha256:0fe7b39194b283f150846cdd54f23557b9b4c61ea26d843438b1af10a04ac38f\",\"mode\":\"normal\",\"schemaVersion\":1}",
  },
  100: {
    "bytes-under": "{\"errorId\":\"muse-candidate-capacity-error:sha256:91391b01d5292bdd0f0cd2bef56fda13ea730a0250c1dd77019894cd0a92b9fe\",\"firstViolatedAxis\":\"bytes\",\"inventoryId\":\"muse-candidate-inventory:sha256:a42e8456b52fba30ceb4ef220abca945649cc9ee088b67df6efa2ec948eace00\",\"minimumRequired\":{\"maxEstimatedTokens\":154,\"maxOutputBytes\":615},\"mode\":\"invalid-input\",\"reasonId\":\"minimum-abstention-exceeds-budget\",\"schemaVersion\":1}",
    "bytes-exact": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":100,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"muse-candidate-inventory:sha256:4c2e5572c4abd3270cc08de8560f98b71a95e7dcf0035ca6d3a18778be9ee39d\",\"ledgerId\":\"muse-candidate-ledger:sha256:ce2e7eeeda90904c297c5573a2f9bfe55f2ee65f76c476bd409fd3a51bf847b2\",\"mode\":\"normal\",\"schemaVersion\":1}",
    "bytes-over": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":100,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"muse-candidate-inventory:sha256:e052620fcadcfdb053f11bd21f2d878c358fb6227d192821c0a60f614663d7d3\",\"ledgerId\":\"muse-candidate-ledger:sha256:05eb2540a91246c010af6ce1af5034589939ba2ff5e478c2cbb4537fa72637a0\",\"mode\":\"normal\",\"schemaVersion\":1}",
    "token-under": "{\"errorId\":\"muse-candidate-capacity-error:sha256:7dffb77b0fcd7bcec16037b7d2d440046f5eb44f1136a4c8a49fefb3033c7c97\",\"firstViolatedAxis\":\"token\",\"inventoryId\":\"muse-candidate-inventory:sha256:bb316510602ecae5f0b7f68e35bba982b4d2ece710e9b3e2d6cb20fc5f13f01a\",\"minimumRequired\":{\"maxEstimatedTokens\":154,\"maxOutputBytes\":615},\"mode\":\"invalid-input\",\"reasonId\":\"minimum-abstention-exceeds-budget\",\"schemaVersion\":1}",
    "token-exact": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":100,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"muse-candidate-inventory:sha256:0e535e9b063ae6719af3305e6f433d6772e4aac5466e27276147781c0865daae\",\"ledgerId\":\"muse-candidate-ledger:sha256:e9874818a8787f8119b6a95f7b3aba253ce06873733b46b254b83823e82d3d74\",\"mode\":\"normal\",\"schemaVersion\":1}",
    "token-over": "{\"counters\":{\"admitted\":1,\"candidateCount\":1,\"consideredAssertions\":100,\"failed\":0,\"maxDepth\":0,\"rejected\":0,\"selectedAssertions\":0,\"selectedPayloadBytes\":0,\"selectedPayloadEstimatedTokens\":0,\"skipped\":0,\"visitedRefs\":0},\"entries\":[{\"candidateId\":\"core\",\"role\":\"core\",\"terminalState\":\"admitted\"}],\"inventoryId\":\"muse-candidate-inventory:sha256:48dd7d1864b3716799a6d53f8d85b0d897821eff5ee49e7a0137f79d126e874b\",\"ledgerId\":\"muse-candidate-ledger:sha256:47adf5549d6b29ffd3d5f082f9bcf84f25230ba390b3347621e4e77a065ddb5f\",\"mode\":\"normal\",\"schemaVersion\":1}",
  },
};
const capacityVariantDiscriminants = {
  "bytes-under": "invalid-input",
  "bytes-exact": "settled",
  "bytes-over": "settled",
  "token-under": "invalid-input",
  "token-exact": "settled",
  "token-over": "settled",
};
const baseMetadata = {
  9: { bytes: 549, estimatedTokens: 138, id: "muse-candidate-ledger:sha256:906e670c57d9dd5ce87d226e0345b1ddfd183cf172d25a351b0618eb7088c07c", totalOutputBytes: 549 },
  10: { bytes: 550, estimatedTokens: 138, id: "muse-candidate-ledger:sha256:ba191fce935dc2ebafff1c61b48354d149a1016a52de667424da64246c0157c8", totalOutputBytes: 550 },
  99: { bytes: 550, estimatedTokens: 138, id: "muse-candidate-ledger:sha256:6a31fc757254ac4c107729dca474cf5612cd1ca482dc6d2d9e21ce79f0bd5e33", totalOutputBytes: 550 },
  100: { bytes: 551, estimatedTokens: 138, id: "muse-candidate-ledger:sha256:df29dbaee42c16bee4d2f7c836210df5ecf8f8e69aadd49a9d8d1f0386da57d0", totalOutputBytes: 551 },
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
  const inventory = verifyLiteral(inventoryCanonicalJson[considered], "muse.attunement-graph.candidate-inventory.v1", "inventoryId", "muse-candidate-inventory:sha256:");
  const expectedBase = verifyLiteral(baseCanonicalJson[considered], "muse.attunement-graph.candidate-settlement-ledger.v1", "ledgerId", "muse-candidate-ledger:sha256:");
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
      invalid ? "muse.attunement-graph.candidate-settlement-capacity-error.v1" : "muse.attunement-graph.candidate-settlement-ledger.v1",
      invalid ? "errorId" : "ledgerId",
      invalid ? "muse-candidate-capacity-error:sha256:" : "muse-candidate-ledger:sha256:",
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
      assert.deepEqual(plain(actual.error.minimumRequired), { maxEstimatedTokens: 154, maxOutputBytes: 615 });
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
const root = await import("@muse/attunement-graph");
assert.deepEqual(Object.keys(root).sort(), [
  "ACTIVATION_PREDICATES",
  "AttunementGraphError",
  "GRAPH_ASSERTION_SOURCE_NAMESPACE",
  "GRAPH_DERIVATION_KINDS",
  "GRAPH_DIRECTIONS",
  "GRAPH_EPISTEMIC_CLASSES",
  "GRAPH_NODE_KINDS",
  "GRAPH_PREDICATES",
  "InMemoryAttunementGraphStore",
  "MAX_ACTIVATION_ESTIMATED_TOKENS",
  "MAX_GRAPH_APPEND_BATCH_ASSERTIONS",
  "MAX_GRAPH_ASSERTION_SOURCE_REFS",
  "MAX_GRAPH_QUERY_ASSERTIONS",
  "MAX_GRAPH_QUERY_CONSIDERED_ASSERTIONS",
  "MAX_GRAPH_QUERY_DEPTH",
  "MAX_GRAPH_QUERY_SEEDS",
  "MAX_GRAPH_QUERY_VISITED_REFS",
  "compileActivationSubgraph",
]);
await assert.rejects(import("@muse/attunement-graph/candidate-settlement-ledger"), (error) => error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED");
