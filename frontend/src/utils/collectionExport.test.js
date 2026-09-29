import assert from 'node:assert/strict';
import { buildCollectionExport } from './collectionExport.js';

const cards = [{ card_id: 'test', name: 'Ghalta, "Stampede"\nTyrant', set_id: 'lci', number: '185', quantity: 5, purchase_price: 0 }];
assert.equal(buildCollectionExport(cards, 'csv'), '"Card ID","Name","Set Name","Set ID","Card Number","Quantity","Condition","Printing","Language","Purchase Price"\r\n"test","Ghalta, ""Stampede""\nTyrant","","lci","185","5","","","","0"');
assert.equal(buildCollectionExport([{ name: 'Forest', set_id: 'fdn', number: '280', quantity: 3 }], 'txt'), 'Deck\n3 Forest (FDN) 280');
const entries = [
  { card_id: 'forest', name: 'Forest', set_id: 'fdn', number: '280', quantity: 1, condition: 'Near Mint', purchase_price: 2 },
  { card_id: 'forest', name: 'Forest', set_id: 'fdn', number: '280', quantity: 2, condition: 'Played', purchase_price: 0.5 },
];
assert.equal(buildCollectionExport(entries, 'csv'), '"Card ID","Name","Set Name","Set ID","Card Number","Quantity","Condition","Printing","Language","Purchase Price"\r\n"forest","Forest","","fdn","280","1","Near Mint","","","2"\r\n"forest","Forest","","fdn","280","2","Played","","","0.5"');
assert.equal(buildCollectionExport(entries, 'txt'), 'Deck\n3 Forest (FDN) 280');
console.log('Collection export serialization passed');
