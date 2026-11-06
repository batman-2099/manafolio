const foilTreatments = require('../../../shared/foilTreatments.json');

function resolveFoilTreatment(printing, supplied, previous) {
  if (supplied != null && (typeof supplied !== 'string' || !Object.hasOwn(foilTreatments, supplied))) {
    throw Object.assign(new Error('Invalid foil treatment'), { status: 400 });
  }
  if (printing === 'Normal') return null;
  if (printing !== 'Holofoil') throw Object.assign(new Error('Invalid printing'), { status: 400 });
  if (supplied === undefined && previous?.printing === 'Holofoil') return previous.foil_treatment ?? null;
  return supplied ?? null;
}

module.exports = { resolveFoilTreatment };
