import test from "node:test";
import assert from "node:assert/strict";
import {
  METADATA_SCHEMA_VERSION,
  preserveMetadataForUpdate,
  readMetadata,
  resolveStoredMetadata,
  writeMetadata
} from "../storage.mjs";

function createStorage(initial = {}) {
  const values = structuredClone(initial);
  return {
    values,
    async get(keys) {
      return Object.fromEntries(keys.filter((key) => key in values).map((key) => [key, values[key]]));
    },
    async set(next) {
      Object.assign(values, structuredClone(next));
    }
  };
}

test("旧バージョンのmetadataをそのまま読み込む", async () => {
  const metadata = { "1": { bookmarkId: "1", description: "過去のメモ", updatedAt: 1 } };
  const storage = createStorage({ metadata });
  assert.deepEqual(await readMetadata(storage), metadata);
});

test("更新時に旧形式を消さずバックアップとスキーマ番号を追加する", async () => {
  const metadata = { "1": { bookmarkId: "1", description: "過去のメモ", updatedAt: 1 } };
  const storage = createStorage({ metadata });
  await preserveMetadataForUpdate(storage);
  assert.deepEqual(storage.values.metadata, metadata);
  assert.deepEqual(storage.values.metadataBackup, metadata);
  assert.equal(storage.values.metadataSchemaVersion, METADATA_SCHEMA_VERSION);
});

test("metadataが壊れた場合はバックアップを読み込む", () => {
  const backup = { "1": { description: "退避済みメモ" } };
  assert.deepEqual(resolveStoredMetadata({ metadata: null, metadataBackup: backup }), backup);
});

test("更新時にmetadataが空でも非空のバックアップを復元する", () => {
  const backup = { "1": { description: "更新前のメモ" } };
  assert.deepEqual(resolveStoredMetadata({ metadata: {}, metadataBackup: backup }), backup);
});

test("利用者が全メモを削除した場合は空のmetadataを維持する", () => {
  const backup = { "1": { description: "削除前のメモ" } };
  assert.deepEqual(resolveStoredMetadata({
    metadata: {},
    metadataBackup: backup,
    metadataEmptyIsIntentional: true
  }), {});
});

test("保存時にmetadataとバックアップを同時更新する", async () => {
  const storage = createStorage();
  const metadata = { "2": { description: "新しいメモ" } };
  await writeMetadata(storage, metadata);
  assert.deepEqual(storage.values.metadata, metadata);
  assert.deepEqual(storage.values.metadataBackup, metadata);
});

test("全メモ削除時も非空のバックアップを保持する", async () => {
  const backup = { "2": { description: "削除前のメモ" } };
  const storage = createStorage({ metadata: backup, metadataBackup: backup });
  await writeMetadata(storage, {});
  assert.deepEqual(storage.values.metadata, {});
  assert.deepEqual(storage.values.metadataBackup, backup);
  assert.equal(storage.values.metadataEmptyIsIntentional, true);
});
