import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createIsolatedStore,
  findItemByText,
  openSqlite,
} from "./helpers/transcript-store.mjs";

test("exports retrieval, relationship, receipt, and provider public types", async () => {
  const declarations = await readFile(
    new URL("../dist/index.d.ts", import.meta.url),
    "utf8",
  );
  const typeDeclarations = await readFile(
    new URL("../dist/types.d.ts", import.meta.url),
    "utf8",
  );
  const compactDeclarations = declarations.replace(/\s+/g, " ");
  const compactTypeDeclarations = typeDeclarations.replace(/\s+/g, " ");

  for (const exportedType of [
    "EmbeddingProvider",
    "SearchContextInput",
    "SearchContextResult",
    "StoredRelationship",
    "RelationshipType",
    "RelationshipEntityType",
    "StoredAssemblyReceipt",
  ]) {
    assert.match(compactDeclarations, new RegExp(`\\b${exportedType}\\b`));
  }

  assert.match(
    compactTypeDeclarations,
    /embeddingProvider\?: EmbeddingProvider/,
  );
  assert.match(
    compactDeclarations,
    /searchContext\(input: SearchContextInput\): Promise<SearchContextResult>/,
  );
  assert.match(
    compactDeclarations,
    /refreshThreadSearchIndex\(threadId: string\): Promise<void>/,
  );
  assert.match(
    compactDeclarations,
    /getAssemblyReceipt\(assemblyId: string\): Promise<StoredAssemblyReceipt \| undefined>/,
  );
  assert.match(
    compactDeclarations,
    /listThreadAssemblyReceipts\(threadId: string\): Promise<StoredAssemblyReceipt\[]>/,
  );
  assert.match(
    compactDeclarations,
    /listThreadRelationships\(threadId: string\): Promise<StoredRelationship\[]>/,
  );
});

test("creates retrieval, relationship, and receipt tables with constraints", async (t) => {
  const { closeStore, sqlitePath } = await createIsolatedStore(t);

  await closeStore();

  const db = openSqlite(sqlitePath);

  try {
    const tableNames = new Set(
      db
        .prepare(
          `SELECT name
          FROM sqlite_schema
          WHERE type = 'table'`,
        )
        .all()
        .map((row) => row.name),
    );

    for (const tableName of [
      "search_index_entries",
      "relationships",
      "assembly_receipts",
      "assembly_receipt_items",
    ]) {
      assert.equal(tableNames.has(tableName), true, tableName);
    }

    assertTableColumns(db, "search_index_entries", [
      "search_index_entry_id",
      "thread_id",
      "entity_type",
      "entity_id",
      "text_kind",
      "embedding_json",
      "lexical_text",
      "created_at",
      "updated_at",
    ]);
    assertTableColumns(db, "relationships", [
      "relationship_id",
      "thread_id",
      "relationship_type",
      "from_entity_type",
      "from_entity_id",
      "to_entity_type",
      "to_entity_id",
      "reason",
      "created_at",
    ]);
    assertTableColumns(db, "assembly_receipts", [
      "assembly_id",
      "thread_id",
      "active_turn",
      "status",
      "estimated_tokens",
      "created_at",
    ]);
    assertTableColumns(db, "assembly_receipt_items", [
      "assembly_id",
      "item_index",
      "entity_type",
      "entity_id",
      "section_kind",
      "included",
      "estimated_tokens",
      "score",
      "reason_json",
      "omit_reason",
    ]);

    const relationshipSql = db
      .prepare(
        `SELECT sql
        FROM sqlite_schema
        WHERE type = 'table' AND name = 'relationships'`,
      )
      .get().sql;
    assert.match(relationshipSql, /derived_from/);
    assert.match(relationshipSql, /same_topic_as/);
    assert.match(relationshipSql, /refines/);
    assert.match(relationshipSql, /supersedes/);
    assert.match(relationshipSql, /resolved_by/);

    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO assembly_receipts (
              assembly_id,
              thread_id,
              active_turn,
              status,
              estimated_tokens,
              created_at
            ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            "receipt-invalid-status",
            "thread-schema",
            1,
            "raw_content",
            0,
            "2026-07-08T00:00:00.000Z",
          ),
      /constraint|CHECK/i,
    );
  } finally {
    db.close();
  }
});

test("search ranks indexed context with deterministic vectors, lexical fallback, and stable ties", async (t) => {
  const { store } = await createIsolatedStore(t, {
    embeddingProvider: keywordEmbeddingProvider(),
  });
  const fixture = await createSearchFixture(store, "thread-search-ranking");

  await store.refreshThreadSearchIndex(fixture.threadId);

  const vectorResult = await store.searchContext({
    threadId: fixture.threadId,
    query: "storage retry backoff",
    limit: 4,
  });

  assert.equal(vectorResult.threadId, fixture.threadId);
  assert.equal(vectorResult.query, "storage retry backoff");
  assert.equal(vectorResult.results[0].entityType, "context_block");
  assert.equal(
    vectorResult.results[0].entityId,
    fixture.blocks.storage.contextBlockId,
  );
  assert.ok(vectorResult.results[0].score > vectorResult.results[1].score);
  assert.ok(
    vectorResult.results[0].reasons.some((reason) =>
      /vector|similarity/i.test(reason),
    ),
  );

  const lexicalResult = await store.searchContext({
    threadId: fixture.threadId,
    query: "redwood immutable exact value",
    limit: 3,
  });

  assert.equal(lexicalResult.results[0].entityType, "source_item");
  assert.equal(
    lexicalResult.results[0].entityId,
    fixture.items.redwoodExact.sourceItemId,
  );
  assert.ok(
    lexicalResult.results[0].reasons.some((reason) =>
      /lexical|keyword/i.test(reason),
    ),
  );

  const firstTie = await store.searchContext({
    threadId: fixture.threadId,
    query: "same topic stable tie",
    limit: 10,
  });
  const secondTie = await store.searchContext({
    threadId: fixture.threadId,
    query: "same topic stable tie",
    limit: 10,
  });

  assert.deepEqual(
    firstTie.results.map(resultIdentity),
    secondTie.results.map(resultIdentity),
  );
});

test("records derived, related, and explicit relationship edges", async (t) => {
  const { store } = await createIsolatedStore(t, {
    embeddingProvider: keywordEmbeddingProvider(),
  });
  const fixture = await createRelationshipFixture(
    store,
    "thread-relationships",
  );

  await store.refreshThreadSearchIndex(fixture.threadId);

  const relationships = await store.listThreadRelationships(fixture.threadId);

  assert.ok(
    relationships.some(
      (relationship) =>
        relationship.relationshipType === "derived_from" &&
        relationship.fromEntityType === "context_block" &&
        relationship.fromEntityId === fixture.blocks.legacy.contextBlockId &&
        relationship.toEntityType === "source_item" &&
        relationship.toEntityId === fixture.items.legacy.sourceItemId,
    ),
  );
  assert.ok(
    relationships.some(
      (relationship) =>
        relationship.relationshipType === "same_topic_as" &&
        relationship.fromEntityType === "context_block" &&
        relationship.toEntityType === "context_block" &&
        new Set([relationship.fromEntityId, relationship.toEntityId]).size ===
          2,
    ),
  );
  assert.ok(
    relationships.some(
      (relationship) =>
        relationship.relationshipType === "supersedes" &&
        relationship.fromEntityId ===
          fixture.blocks.replacement.contextBlockId &&
        relationship.toEntityId === fixture.blocks.legacy.contextBlockId,
    ),
  );
  assert.ok(
    relationships.some(
      (relationship) =>
        relationship.relationshipType === "resolved_by" &&
        relationship.fromEntityType === "source_item" &&
        relationship.fromEntityId === fixture.items.openQuestion.sourceItemId &&
        relationship.toEntityType === "context_block" &&
        relationship.toEntityId === fixture.blocks.resolution.contextBlockId,
    ),
  );
});

test("assembly ranks request-relevant middle context and persists raw-free receipts", async (t) => {
  const { sqlitePath, store } = await createIsolatedStore(t, {
    embeddingProvider: keywordEmbeddingProvider(),
  });
  const fixture = await createAssemblyRankingFixture(
    store,
    "thread-ranked-assembly",
  );
  const fullPacket = await store.assembleContext({
    threadId: fixture.threadId,
    activeTurn: 9,
    task: "Continue storage retry backoff work",
    scope: "core retrieval",
  });
  const rankedBlock = fullPacket.sections
    .find((section) => section.kind === "compacted_context_blocks")
    .items.find(
      (item) => item.contextBlockId === fixture.blocks.storage.contextBlockId,
    );

  assert.ok(rankedBlock);

  const budget =
    estimateItems(
      fullPacket.sections
        .filter((section) =>
          ["full_transcript_anchors", "recent_full_transcript"].includes(
            section.kind,
          ),
        )
        .flatMap((section) => section.items),
    ) + estimateText(rankedBlock.text);
  const packet = await store.assembleContext({
    threadId: fixture.threadId,
    activeTurn: 9,
    task: "Continue storage retry backoff work",
    scope: "core retrieval",
    tokenBudget: budget,
  });

  assert.deepEqual(
    getSection(packet, "full_transcript_anchors").items.map(
      (item) => item.turnIndex,
    ),
    [1, 2, 3],
  );
  assert.deepEqual(
    getSection(packet, "recent_full_transcript").items.map(
      (item) => item.turnIndex,
    ),
    [8],
  );
  assert.deepEqual(
    getSection(packet, "compacted_context_blocks").items.map(
      (item) => item.contextBlockId,
    ),
    [fixture.blocks.storage.contextBlockId],
  );
  assert.doesNotMatch(
    renderPacketText(packet),
    /visual regression screenshot diff/i,
  );
  assert.equal(packet.receipt.status, "assembled");
  assert.ok(Array.isArray(packet.receipt.items));
  assert.ok(
    packet.receipt.items.some(
      (item) =>
        item.entityId === fixture.blocks.storage.contextBlockId &&
        item.included === true &&
        item.score > 0 &&
        item.reasons.some((reason) =>
          /task|scope|vector|lexical/i.test(reason),
        ),
    ),
  );
  assert.ok(
    packet.receipt.items.some(
      (item) =>
        item.entityId === fixture.blocks.ui.contextBlockId &&
        item.included === false &&
        /budget|rank/i.test(item.omitReason),
    ),
  );

  const storedReceipt = await store.getAssemblyReceipt(
    packet.receipt.assemblyId,
  );
  const listedReceipts = await store.listThreadAssemblyReceipts(
    fixture.threadId,
  );

  assert.deepEqual(storedReceipt, packet.receipt);
  assert.deepEqual(
    listedReceipts.map((receipt) => receipt.assemblyId),
    [packet.receipt.assemblyId],
  );

  const db = openSqlite(sqlitePath);

  try {
    const receiptRows = db
      .prepare(
        `SELECT *
        FROM assembly_receipts`,
      )
      .all();
    const receiptItemRows = db
      .prepare(
        `SELECT *
        FROM assembly_receipt_items`,
      )
      .all();
    const persistedReceiptPayload = JSON.stringify([
      receiptRows,
      receiptItemRows,
    ]);

    assert.doesNotMatch(
      persistedReceiptPayload,
      /sensitive redwood transcript raw/i,
    );
    assert.doesNotMatch(persistedReceiptPayload, /storage retry backoff/i);
    assert.doesNotMatch(persistedReceiptPayload, /recent raw body/i);
  } finally {
    db.close();
  }
});

test("assembly suppresses context blocks that are explicitly superseded", async (t) => {
  const { store } = await createIsolatedStore(t, {
    embeddingProvider: keywordEmbeddingProvider(),
  });
  const fixture = await createRelationshipFixture(
    store,
    "thread-superseded-assembly",
  );

  const packet = await store.assembleContext({
    threadId: fixture.threadId,
    activeTurn: 10,
    task: "Continue storage retrieval cache work",
    scope: "core",
    tokenBudget: 5000,
  });
  const blockIds = getSection(packet, "compacted_context_blocks").items.map(
    (item) => item.contextBlockId,
  );

  assert.ok(blockIds.includes(fixture.blocks.replacement.contextBlockId));
  assert.equal(blockIds.includes(fixture.blocks.legacy.contextBlockId), false);
  assert.ok(
    packet.receipt.items.some(
      (item) =>
        item.entityId === fixture.blocks.legacy.contextBlockId &&
        item.included === false &&
        /superseded/i.test(item.omitReason),
    ),
  );
});

async function createSearchFixture(store, threadId) {
  await appendAnchors(store, threadId);
  const storageTurn = await store.appendTurn({
    threadId,
    turnRole: "model",
    raw: "I inspected storage retry queue because exponential backoff remains in progress.",
  });
  const uiTurn = await store.appendTurn({
    threadId,
    turnRole: "model",
    raw: "I inspected dashboard pixel polish because screenshot alignment remains in progress.",
  });
  const exactTurn = await store.appendTurn({
    threadId,
    turnRole: "user",
    raw: "Rules:\n- The redwood immutable exact value must stay verbatim.",
  });
  await store.appendTurn({
    threadId,
    turnRole: "model",
    raw: "I inspected same topic stable tie because the ranking check remains in progress.",
  });
  await store.appendTurn({
    threadId,
    turnRole: "model",
    raw: "I reviewed same topic stable tie because the ranking check remains in progress.",
  });

  const storage = findItemByText(
    await store.listTurnSourceItems(storageTurn.turnId),
    "storage retry queue",
  );
  const ui = findItemByText(
    await store.listTurnSourceItems(uiTurn.turnId),
    "dashboard pixel polish",
  );
  const redwoodExact = findItemByText(
    await store.listTurnSourceItems(exactTurn.turnId),
    "redwood immutable exact value",
  );
  const [storageBlock, uiBlock] = await store.buildContextBlocks({
    threadId,
    groups: [
      { sourceItemIds: [storage.sourceItemId] },
      { sourceItemIds: [ui.sourceItemId] },
    ],
  });

  return {
    blocks: {
      storage: storageBlock,
      ui: uiBlock,
    },
    items: {
      redwoodExact,
      storage,
      ui,
    },
    threadId,
  };
}

async function createRelationshipFixture(store, threadId) {
  await appendAnchors(store, threadId);
  const legacyTurn = await store.appendTurn({
    threadId,
    turnRole: "model",
    raw: "I inspected legacy storage cache because retrieval cache behavior remains in progress.",
  });
  const openQuestionTurn = await store.appendTurn({
    threadId,
    turnRole: "user",
    raw: "Which storage cache should resolve the retrieval path?",
  });
  const replacementTurn = await store.appendTurn({
    threadId,
    turnRole: "model",
    raw: "I inspected SQLite storage cache because it supersedes legacy storage cache for retrieval.",
  });
  const resolutionTurn = await store.appendTurn({
    threadId,
    turnRole: "model",
    raw: "I confirmed SQLite storage cache because it resolves which storage cache should resolve the retrieval path.",
  });
  await store.appendTurn({
    threadId,
    turnRole: "model",
    raw: "I inspected recent storage summary because this should remain recent.",
  });
  await store.appendTurn({
    threadId,
    turnRole: "user",
    raw: "Task: Continue storage cache retrieval.",
  });

  const legacy = findItemByText(
    await store.listTurnSourceItems(legacyTurn.turnId),
    "legacy storage cache",
  );
  const openQuestion = findItemByText(
    await store.listTurnSourceItems(openQuestionTurn.turnId),
    "storage cache should resolve",
  );
  const replacement = findItemByText(
    await store.listTurnSourceItems(replacementTurn.turnId),
    "supersedes legacy storage cache",
  );
  const resolution = findItemByText(
    await store.listTurnSourceItems(resolutionTurn.turnId),
    "resolves which storage cache",
  );
  const [legacyBlock, replacementBlock, resolutionBlock] =
    await store.buildContextBlocks({
      threadId,
      groups: [
        { sourceItemIds: [legacy.sourceItemId] },
        { sourceItemIds: [replacement.sourceItemId] },
        { sourceItemIds: [resolution.sourceItemId] },
      ],
    });

  return {
    blocks: {
      legacy: legacyBlock,
      replacement: replacementBlock,
      resolution: resolutionBlock,
    },
    items: {
      legacy,
      openQuestion,
      replacement,
      resolution,
    },
    threadId,
  };
}

async function createAssemblyRankingFixture(store, threadId) {
  await appendAnchors(store, threadId);
  const uiTurn = await store.appendTurn({
    threadId,
    turnRole: "model",
    raw: "I inspected visual regression screenshot diff because dashboard alignment remains in progress.",
  });
  const exactTurn = await store.appendTurn({
    threadId,
    turnRole: "user",
    raw: "Rules:\n- sensitive redwood transcript raw must never be copied to receipts.",
  });
  const storageTurn = await store.appendTurn({
    threadId,
    turnRole: "model",
    raw: "I inspected storage retry backoff because queue recovery remains in progress.",
  });
  await store.appendTurn({
    threadId,
    turnRole: "model",
    raw: "I inspected recent raw body because this recent transcript should stay first.",
  });
  await store.appendTurn({
    threadId,
    turnRole: "user",
    raw: "Task: Continue retrieval assembly.",
  });

  const ui = findItemByText(
    await store.listTurnSourceItems(uiTurn.turnId),
    "visual regression screenshot diff",
  );
  const exact = findItemByText(
    await store.listTurnSourceItems(exactTurn.turnId),
    "sensitive redwood transcript raw",
  );
  const storage = findItemByText(
    await store.listTurnSourceItems(storageTurn.turnId),
    "storage retry backoff",
  );
  const [uiBlock, storageBlock] = await store.buildContextBlocks({
    threadId,
    groups: [
      { sourceItemIds: [ui.sourceItemId] },
      { sourceItemIds: [storage.sourceItemId] },
    ],
  });

  return {
    blocks: {
      storage: storageBlock,
      ui: uiBlock,
    },
    items: {
      exact,
      storage,
      ui,
    },
    threadId,
  };
}

async function appendAnchors(store, threadId) {
  await store.appendTurn({
    threadId,
    turnRole: "user",
    raw: "Task: Anchor the retrieval session.",
  });
  await store.appendTurn({
    threadId,
    turnRole: "model",
    raw: "Decision: Keep the SQLite MVP.",
  });
  await store.appendTurn({
    threadId,
    turnRole: "user",
    raw: "Rules:\n- Keep receipt rows raw-free.",
  });
}

function keywordEmbeddingProvider() {
  const dimensions = [
    ["storage", "retry", "backoff", "queue", "cache", "retrieval"],
    ["dashboard", "pixel", "visual", "screenshot", "alignment"],
    ["auth", "token", "login", "oauth"],
  ];

  return {
    name: "keyword-test",
    dimensions: dimensions.length,
    async embed(texts) {
      return texts.map((text) => {
        const normalized = text.toLowerCase();

        return dimensions.map((keywords) =>
          keywords.reduce(
            (score, keyword) => score + (normalized.includes(keyword) ? 1 : 0),
            0,
          ),
        );
      });
    },
  };
}

function assertTableColumns(db, tableName, expectedColumns) {
  const actualColumns = db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all()
    .map((row) => row.name);

  for (const expectedColumn of expectedColumns) {
    assert.ok(
      actualColumns.includes(expectedColumn),
      `${tableName}.${expectedColumn}`,
    );
  }
}

function resultIdentity(result) {
  return {
    entityId: result.entityId,
    entityType: result.entityType,
    textKind: result.textKind,
  };
}

function getSection(packet, kind) {
  const section = packet.sections.find((candidate) => candidate.kind === kind);

  assert.ok(section, `Expected section ${kind}`);
  return section;
}

function renderPacketText(packet) {
  return packet.sections
    .flatMap((section) => section.items)
    .map((item) => item.text)
    .join("\n");
}

function estimateItems(items) {
  return items.reduce((total, item) => total + estimateText(item.text), 0);
}

function estimateText(text) {
  return Math.ceil(text.length / 4);
}
