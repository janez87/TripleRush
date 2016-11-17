var stream = require('stream');
var util = require('util');
var _ = require('underscore');
var Transform = stream.Transform || require('readable-stream').Transform;
var PropertiesReader = require('properties-reader');
var path = require('path');
var debug = require('debug')('Cache');


function Cache(options) {

  if (!(this instanceof Cache)) {
    return new Cache(options);
  }

  this.configuration = options.configuration;
  this.array = [];
  this.limit = options.limit || 100;

  // init Transform
  Transform.call(this, options);

}
util.inherits(Cache, Transform);

Cache.prototype._write = function(data, enc, callback) {
  //var data = JSON.parse(chunk);
  this.add(_.extend({
    ts: new Date(data['http://www.w3.org/ns/prov#generatedAtTime']).getTime()
  }, _.pick(data, ['http://www.w3.org/ns/prov#generatedAtTime', '@id', '@graph'])));

  debug("Adding %j",data);
  callback();
};

Cache.prototype.add = function(element) {
  if (this.array.length === this.limit) {
    this.array.pop();
  }
  this.array.unshift(element);
};

Cache.prototype.find = function(id) {

  for (var i = this.array.length - 1; i >= 0; i--) {
    var e = this.array[i];

    let splittedId = e['@id'].split('/'); 
    if (splittedId[splittedId.length-1] === id) {
      return e;
    }
  }

  return null;
};

Cache.prototype.clean = function(){
  this.array = [];
}
Cache.prototype.getAll = function() {

  var array = _.clone(this.array);

  var cache = {
    "@context": {
      "sld": "http://streamreasoning.org/ontologies/SLD4TripleWave#",
      "generatedAt": {
        "@id": "http://www.w3.org/ns/prov#generatedAtTime",
        "@type": "http://www.w3.org/2001/XMLSchema#dateTime"
      }
    },
    "@id": "tr:sGraph",
    "sld:contains": {
      "@list": []
    }
  };

  cache['sld:streamEndpoint']=[];
  if(this.configuration.get('ws_enabled')){
    //DEPRECATED: this line should be dismissed, since more endpoints are now possible
    cache['sld:streamLocation'] = this.configuration.get('ws_address');
    cache['sld:streamEndpoint'].push({'rdf:type':{'@id':'sld:WebSocketStreamEndpoint'},'@id':this.configuration.get('ws_address')});
  }
  if(this.configuration.get('mqtt_enabled')){
    cache['sld:streamEndpoint'].push({'rdf:type':{'@id':'sld:MQTTStreamEndpoint'},'@id':'mqtt://' + this.configuration.get('mqtt_broker_address') + ':' + this.configuration.get('mqtt_broker_port'),'sld:mqttTopic':this.configuration.get('mqtt_topic')});
  }
  cache['sld:tBoxLocation'] = {
    "@id": this.configuration.get('tbox_stream_location')
  };

  for (var i = array.length - 1; i >= 0; i--) {
    var e = array[i];
    cache['sld:contains']["@list"].push({
      generatedAt: e['http://www.w3.org/ns/prov#generatedAtTime'],
      "@id": e["@id"]
    });
  }

  if (array.length > 0) {

    cache["sld:lastUpdated"] = array[0]['http://www.w3.org/ns/prov#generatedAtTime'];
  }

  return cache;
};

exports = module.exports = Cache;
