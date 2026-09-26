export const METADATA_SCHEMA_VERSION = 1;

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function resolveStoredMetadata(stored = {}) {
  if (isRecord(stored.metadata)) return stored.metadata;
  if (isRecord(stored.metadataBackup)) return stored.metadataBackup;
  return {};
}

export async function readMetadata(storageArea) {
  const stored = await storageArea.get([
    "metadata",
    "metadataBackup",
    "metadataSchemaVersion"
  ]);
  return resolveStoredMetadata(stored);
}

export async function writeMetadata(storageArea, metadata) {
  if (!isRecord(metadata)) throw new TypeError("metadata must be an object");
  await storageArea.set({
    metadata,
    metadataBackup: metadata,
    metadataSchemaVersion: METADATA_SCHEMA_VERSION
  });
}

export async function preserveMetadataForUpdate(storageArea) {
  const metadata = await readMetadata(storageArea);
  await writeMetadata(storageArea, metadata);
  return metadata;
}
