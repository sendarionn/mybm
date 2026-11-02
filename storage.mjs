export const METADATA_SCHEMA_VERSION = 2;

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasMetadata(metadata) {
  return isRecord(metadata) && Object.keys(metadata).length > 0;
}

export function resolveStoredMetadata(stored = {}) {
  if (hasMetadata(stored.metadata)) return stored.metadata;
  if (stored.metadataEmptyIsIntentional && isRecord(stored.metadata)) return stored.metadata;
  if (isRecord(stored.metadataBackup)) return stored.metadataBackup;
  if (isRecord(stored.metadata)) return stored.metadata;
  return {};
}

export async function readMetadata(storageArea) {
  const stored = await storageArea.get([
    "metadata",
    "metadataBackup",
    "metadataEmptyIsIntentional",
    "metadataSchemaVersion"
  ]);
  return resolveStoredMetadata(stored);
}

export async function writeMetadata(storageArea, metadata) {
  if (!isRecord(metadata)) throw new TypeError("metadata must be an object");
  const stored = await storageArea.get(["metadataBackup"]);
  const empty = !hasMetadata(metadata);
  await storageArea.set({
    metadata,
    metadataBackup: empty && hasMetadata(stored.metadataBackup)
      ? stored.metadataBackup
      : metadata,
    metadataEmptyIsIntentional: empty,
    metadataSchemaVersion: METADATA_SCHEMA_VERSION
  });
}

export async function preserveMetadataForUpdate(storageArea) {
  const metadata = await readMetadata(storageArea);
  if (!hasMetadata(metadata)) return metadata;
  await writeMetadata(storageArea, metadata);
  return metadata;
}

export function removeMetadataEntries(metadata, ids) {
  let changed = false;
  for (const id of ids) {
    if (metadata[id]) {
      delete metadata[id];
      changed = true;
    }
  }
  return changed;
}
