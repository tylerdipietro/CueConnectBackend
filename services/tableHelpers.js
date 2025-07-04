// services/tableHelpers.js

const Table = require('../models/Table');
const Venue = require('../models/Venue'); // Needed for populating venue and getting perGameCost
const { populateTablePlayersDetails, populateQueueWithUserDetails } = require('./gameService'); // Assuming gameService is in the same 'services' directory

/**
 * Helper function to get a fully populated table object with perGameCost.
 * This function is designed to be independent and reusable across modules.
 * @param {string} tableId - The ID of the table to populate.
 * @returns {Promise<object|null>} A promise that resolves to the populated table object, or null if not found/error.
 */
async function getPopulatedTableWithPerGameCost(tableId) {
  try {
    console.log(`[TABLE_HELPER] Fetching table ${tableId} for population...`);
    // Populate venueId to access perGameCost
    const table = await Table.findById(tableId).populate('venueId');

    if (!table) {
      console.warn(`[TABLE_HELPER] Table ${tableId} not found.`);
      return null;
    }

    // Ensure venueId is populated before accessing its properties
    if (!table.venueId) {
      console.error(`[TABLE_HELPER] Venue not populated for table ${tableId}. Cannot get perGameCost. Returning table without cost.`);
      const populatedQueue = await populateQueueWithUserDetails(table.queue);
      const tableWithQueue = { ...table.toObject(), queue: populatedQueue };
      const fullyPopulatedTable = await populateTablePlayersDetails(tableWithQueue);
      return { ...fullyPopulatedTable, perGameCost: null }; // Indicate missing cost
    }

    console.log(`[TABLE_HELPER] Table ${tableId} venueId populated: ${table.venueId._id}`);
    const venuePerGameCost = typeof table.venueId.perGameCost === 'number' ? table.venueId.perGameCost : 10;
    console.log(`[TABLE_HELPER] Table ${tableId} perGameCost from venue: ${venuePerGameCost}`);

    const populatedQueue = await populateQueueWithUserDetails(table.queue);
    // Convert Mongoose document to plain object before adding properties
    const tableObject = table.toObject();
    const tableWithQueue = { ...tableObject, queue: populatedQueue };
    const fullyPopulatedTable = await populateTablePlayersDetails(tableWithQueue);

    const finalTableData = { ...fullyPopulatedTable, perGameCost: venuePerGameCost };
    console.log(`[TABLE_HELPER] Final populated table data for ${tableId} (perGameCost: ${finalTableData.perGameCost}):`, JSON.stringify(finalTableData, null, 2));
    return finalTableData;
  } catch (error) {
    console.error(`[TABLE_HELPER] Error in getPopulatedTableWithPerGameCost for table ${tableId}:`, error);
    return null; // Return null on error
  }
}

module.exports = {
  getPopulatedTableWithPerGameCost
};
