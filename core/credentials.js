import fs from 'fs-extra';
import yaml from 'yaml';
import path from 'path';

/**
 * Load credentials from a YAML file.
 *
 * Expected format:
 * credentials:
 *   - label: "Main test account"
 *     fields:
 *       email: testuser@example.com
 *       password: secret
 *       username: testuser
 *
 * Returns a flat object keyed by label for easy lookup:
 * {
 *   "Main test account": { email: "...", password: "...", username: "..." }
 * }
 */
export async function loadCredentials(filePath) {
  const resolved = path.resolve(process.cwd(), filePath);

  if (!await fs.pathExists(resolved)) {
    throw new Error(`Credentials file not found: ${resolved}`);
  }

  const content = await fs.readFile(resolved, 'utf-8');
  const parsed = yaml.parse(content);

  if (!parsed || !parsed.credentials) {
    throw new Error('Invalid credentials file. Expected "credentials:" key at root.');
  }

  const result = {};
  for (const entry of parsed.credentials) {
    if (entry.label && entry.fields) {
      result[entry.label] = entry.fields;
    }
  }

  if (Object.keys(result).length === 0) {
    throw new Error('No valid credential entries found in file.');
  }

  return result;
}
