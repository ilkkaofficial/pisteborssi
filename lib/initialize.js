import { AppError, fail, unavailable } from './errors.js';
import { hashTemporaryPassword, validateTemporaryPassword } from './crypto.js';
import { FAMILY, initialState } from './ledger.js';

// Invoked by normal, validated API requests. No caller-supplied users or passwords.
// PostgreSQL's existing pb_initialize lock/transaction is the cross-instance guard.
export async function initializedSnapshot(store, initialPassword, sessionHash = null) {
  const snapshot = await store.snapshot(sessionHash);
  if (snapshot.ready) return snapshot; // Never inspect the setup secret or reset a live DB.
  try {
    validateTemporaryPassword(initialPassword);
  } catch {
    fail(503, 'initialization_required', 'Ensialustus puuttuu. Lisää Vercelin Production-palvelinasetuksiin INITIAL_USER_PASSWORD (tilapäinen aloitussalasana, 5–256 merkkiä), tee Redeploy ja avaa sovellus uudelleen. Älä tallenna salasanaa projektitiedostoihin.');
  }
  const accounts = [];
  // Sequential hashing bounds memory use on a serverless instance.
  for (const person of FAMILY) {
    accounts.push({ personId: person.id, username: person.id,
      credential: await hashTemporaryPassword(initialPassword) });
  }
  try {
    await store.initialize(initialState(), accounts);
  } catch (error) {
    // Another Vercel instance may have won. Re-read it, never replace it.
    if (!(error instanceof AppError) || error.code !== 'already_initialized') throw error;
  }
  const current = await store.snapshot(sessionHash);
  if (!current.ready) throw unavailable();
  return current;
}
