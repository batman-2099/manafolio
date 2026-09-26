import assert from 'node:assert/strict';
import { buildCollectionExport } from './collectionExport.js';

const cards = [{ card_id: 'test', name: 'Ghalta, "Stampede"\nTyrant', set_id: 'lci', number: '185', quantity: 5, purchase_price: 0 }];
assert.equal(buildCollectionExport(cards, 'csv'), '"Card ID","Name","Set Name","Set ID","Card Number","Quantity","Condition","Printing","Language","Purchase Price"\r\n"test","Ghalta, ""Stampede""\nTyrant","","lci","185","5","","","","0"');
assert.equal(buildCollectionExport([{ name: 'Forest', set_id: 'fdn', number: '280', quantity: 3 }], 'txt'), 'Deck\n3 Forest (FDN) 280');
console.log('Collection export serialization passed');
