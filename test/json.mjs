/**
 * Integration fixtures deliberately send invalid shapes; runtime assertions
 * establish the response contract for each scenario.
 * @param {Response} response
 * @returns {Promise<Record<string, any>>}
 */
export async function readJSON(response) {
  return /** @type {Record<string, any>} */ (await response.json());
}
