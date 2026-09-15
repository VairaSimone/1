const test=require("node:test");
const assert=require("node:assert/strict");
const {shortestRoute,haversineMeters}=require("../src/services/action-service");
const {LOCATION_RESOURCES,LOCATION_OBJECTS}=require("../src/services/physical-world-service");
const {EVENTS,WEATHER}=require("../src/services/environment-service");

test("route uses connected path and real geographic distance",()=>{
  const locations=[
    {locationId:"a",latitude:45,longitude:7,data:{worldCode:"A",connections:["B"]}},
    {locationId:"b",latitude:45,longitude:7.01,data:{worldCode:"B",connections:["A","C"]}},
    {locationId:"c",latitude:45,longitude:7.02,data:{worldCode:"C",connections:["B"]}}
  ];
  const route=shortestRoute(locations,"a","c");
  assert.deepEqual(route.path,["a","b","c"]);
  assert.ok(route.distanceMeters>1000);
  assert.equal(haversineMeters(locations[0],locations[2])>route.distanceMeters,false);
});

test("physical locations expose concrete resources and objects",()=>{
  assert.ok(LOCATION_RESOURCES.HOME.water>0);
  assert.ok(LOCATION_RESOURCES.GROCERY.food>LOCATION_RESOURCES.CAFE.food);
  assert.ok(LOCATION_OBJECTS.HOME.includes("bed"));
  assert.ok(LOCATION_OBJECTS.LIBRARY.includes("bookshelves"));
});

test("environment model contains localized weather and activity events",()=>{
  assert.ok(WEATHER.STORM.visibility<WEATHER.CLEAR.visibility);
  assert.ok(EVENTS.PARK.some(event=>event[0]==="RAIN"));
  assert.ok(EVENTS.SHOP.some(event=>event[0]==="RESTOCK"));
  assert.ok(EVENTS.LIBRARY.some(event=>event[0]==="BOOK_RETURN"));
});
