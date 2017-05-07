const Primus = require('primus');
const stream = require('stream');
const path = require('path');
const debug = require('debug')('tw:App')
const express = require('express');
const favicon = require('serve-favicon');
const bodyParser = require('body-parser')
const fs = require('fs')
const async = require('async');
const JSONStream = require('JSONStream')
const program = require('commander');

const Cache = require('./stream/cache');
const Enricher = require('./stream/enricher');
const Queue = require('./stream/queue');
const Bottleneck = require("./stream/datagen/bottleneck");
const FakeDataGen = require('./stream/datagen/fakeDataGen');
let configuration;

// TODO: rifarlo con le promise
let cache = null;
let toUse = null;
let bottleneck = new Bottleneck({ objectMode: true,    configuration: configuration });
let fakeDataGen = null;

let parseCommandLine = function () {
    debug("parseCommandLine\n")
    program
        .option('-m, --mode [mode]', 'TripleWave running mode', /^(transform|endless|replay|endless_profiled)$/i)
        .option('-c, --configuration [configuration]', 'Path to the configuration file')
        .option('-s, --sources [sources]', 'Source of the data')
        .parse(process.argv);

    configuration = require('./configuration')(program.configuration);
    program.mode ? configuration.set('mode', program.mode) : null;
    program.sources ? configuration.set('sources', program.sources) : null;
    debug(configuration)

};

let configureScheduler = function (options) {

    var Scheduler = require('./stream/scheduler/rdfStreamScheduler')
    options.profilingFunction = require('./stream/scheduler/profilingFunctions/' + configuration.get('profiling_function'));
    options.min = configuration.get('minDelay');

    return new Scheduler(options)
};

let createStreams = function (callback) {

    cache = new Cache({
        objectMode: true,
        limit: 100,
        configuration: configuration
    });

    let queue = new Queue({
        objectMode: true,
        configuration: configuration
    })

    if (configuration.get('mode') !== 'transform') {
        debug("Config Mode %s\n", configuration.get('mode'))

        if (configuration.get('sources') === 'rdfstream') {

            let buildStream = function () {
            
                let options = {
                    objectMode: true,
                    highWaterMark: 1,
                    configuration: configuration
                }

                var DataGen = require('./stream/datagen/rdfStreamDataGen');

                var IdReplacer = require('./stream/idReplacer');

                var datagen = new DataGen(options);

                var scheduler = configureScheduler(options);

                var idReplacer = new IdReplacer(options);

                //compose the stream

                toUse = datagen.pipe(queue);
                toUse = toUse.pipe(scheduler);
                toUse = toUse.pipe(idReplacer);
                if (configuration.get("mode") == 'endless' || configuration.get("mode") == 'endless_profiled') {
                    var Replacer = require('./stream/currentTimestampReplacer');
                    toUse = toUse.pipe(new Replacer(options));

                    toUse.on('end', () => {
                        debug("Stream ended")

                        buildStream();

                        debug('Restarted');
                    });
                }
                toUse.pipe(cache);


            };

            buildStream();

            return callback();
        } else if (configuration.get('sources') === 'triples') {
            var DataGen = require('./stream/datagen/sparqlDataGen');
            debug('Using %s source', configuration.get('sources'));

            let buildStream = function (restart) {

                let options = {
                    objectMode: true,
                    highWaterMark: 1,
                    configuration: configuration
                }

                var datagen = new DataGen(options);
                var scheduler = configureScheduler(options);

                if (!restart) {
                    return datagen.loadData(() => {
                        toUse = datagen.pipe(scheduler);
                        if (configuration.get("mode") == 'endless') {
                            var Replacer = require('./stream/currentTimestampReplacer');
                            toUse = toUse.pipe(new Replacer(options));

                            toUse.on('end', () => {
                                debug("Restarting the stream");
                                buildStream(true);
                            })
                        }

                        toUse.pipe(cache);
                        return callback();
                    });
                } else {

                    // Don't check if TW is in endless mode since this branch is only executed in endless mode
                    toUse = datagen.pipe(queue);
                    toUse = toUse.pipe(scheduler);
                    var Replacer = require('./stream/currentTimestampReplacer');
                    toUse = toUse.pipe(new Replacer(options));
                    toUse.pipe(cache);

                    toUse.on('end', () => {
                        debug("Restarting the stream");
                        buildStream(true);
                    })
                }
            }

            return buildStream(false);
        } else if (configuration.get('sources') === 'stream'){
            debug("Selected Stream Source")
            let buildStream = function () {

                var DataGen = require('./stream/datagen/obdaDataGen');
                var Scheduler = require('./stream/scheduler/rdfStreamScheduler');
                var Scheduler = require('./stream/scheduler/streamScaler');
                //var IdReplacer = require('./stream/idReplacer');
                var Replacer = require('./stream/currentTimestampReplacer');
                
                var datagen = new DataGen({
                    objectMode: true,
                    highWaterMark: 1,
                    configuration: configuration
                });
                
                var scheduler = new Scheduler({
                    objectMode: true,
                    highWaterMark: 1,
                    configuration: configuration,
                    scale: configuration.get('scale_factor')
                });

                var replacer = new Replacer({
                    objectMode: true,
                    highWaterMark: 1,
                    configuration: configuration
                });

                //compose the stream
                // toUse = datagen.pipe(scheduler);
                // toUse = toUse.pipe(replacer);
                // toUse = toUse.pipe(cache);
                // fakeDataGen.unpipe(bottleneck);
                // toUse.pipe(bottleneck);
                if(fakeDataGen)
                    fakeDataGen.unpipe(bottleneck);
                toUse = datagen.pipe(scheduler);
                toUse = toUse.pipe(replacer);
                bottleneck = toUse.pipe(bottleneck);
                bottleneck.pipe(cache);     

                  
            };

            buildStream();

            return callback();
        }
    } else if (configuration.get('mode') === 'transform') {

        let stream = path.resolve(configuration.get('transform_folder'), configuration.get('transform_transformer'));
        debug('Loading stream %s', stream);
        var Webstream = require(stream);

        let IdReplacer = require('./stream/idReplacer');

        var enricher = new Enricher({
            objectMode: true,
            configuration: configuration
        });
        var activeStream = new Webstream({
            objectMode: true,
            configuration: configuration
        });
        var idReplacer = new IdReplacer({
            objectMode: true,
            configuration: configuration
        });


        toUse = activeStream.pipe(queue);
        toUse = toUse.pipe(enricher);
        toUse = toUse.pipe(idReplacer);
        toUse.pipe(cache);

        return callback();
    } 

    if (!toUse) {
        debug('Using dummy data');
        var DataGen = require('./stream/datagen/dummyDataGen');
        var Scheduler = require('./stream/scheduler/dummyScheduler');
        var datagen = new DataGen({
            objectMode: true,
            configuration: configuration
        });
        var scheduler = new Scheduler({
            objectMode: true,
            configuration: configuration
        });
        toUse = datagen.pipe(scheduler);
        toUse.pipe(cache);

        return callback();
    }

};

let startUp = function (callback) {

    debug("Starting up the HTTP Server");
    let app = express();

    let checkTripleWaveStarted = function (req, res, next) {
        debug('Checking if TripleWave started streaming')
        if (toUse || req.originalUrl==='/register') {
            return next();
        }

        return res.status(400).json({
            msg: 'Stream not started, please call the /start endpoint'
        });
    }

    app.use(bodyParser.json())
    app.use(favicon(__dirname + '/public/favicon.ico'));
    //app.use(/\/(?!start\b)\b\w+/, checkTripleWaveStarted);

    app.post('/register',(req,res)=>{
        let body = req.body;

        debug(body)

        body.rdf_stream_item_content_pattern ? configuration.set('rdf_stream_item_content_pattern', body.rdf_stream_item_content_pattern) : null;
        body.rdf_query_endpoint ? configuration.set('rdf_query_endpoint', body.rdf_query_endpoint) : null;
        body.rdf_update_endpoint ? configuration.set('rdf_update_endpoint', body.rdf_update_endpoint) : null;
        body.rdf_guery_get_content ? configuration.set('rdf_guery_get_content', body.rdf_guery_get_content) : null;

        res.json({
            msg: configuration
        })

    })

    debug("Set up /start API")
    app.get('/start', (req, res) => {
        if (!toUse) {
            createStreams(() => {
                return res.json({
                    msg: "streamCreated"
                })
            });
        }
    })

    debug("Set up /stream API")
    app.get('/stream', (req, res) => {

        toUse
            .pipe(JSONStream.stringify())
            .pipe(res);

        res.on('close', () => {
            debug('Closing the HTTP chunk stream');
            toUse.unpipe(res);
        })


    });

    debug("Set up /sgraph API")
    app.get('/sgraph', function (req, res) {
        if(cache){
            return res.json(cache.getAll());
        }else{
            let sgraph = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'rdf/sgraph', configuration.get('sgraph'))).toString());
            sgraph['sld:streamLocation'] = configuration.get('ws_address');
            sgraph['sld:streamName'] = configuration.get('stream_name');
            sgraph['sld:runUUID'] = configuration.get('run_uuid');

            return res.json(sgraph)
        }
        
    });

    debug("Set up /:id API")
    app.get('/:id', function (req, res) {
        debug('Searching element with id ' + req.params.id);

        var element = cache.find(req.params.id);

        if (element) {
            res.json({
                "@graph": element["@graph"]
            });
        } else {
            res.status = 404;
            res.json({
                error: "Element not found"
            });
        }
    });
    
    let server = require('http').createServer(app)

    debug("Initializing Primus")

    let primus = Primus.createServer({
        port: configuration.get('ws_port'),
        transformer: 'websockets',
        timeout: false
    });

    primus.on('initialised', () => {
        
        primus.on('connection', (spark) => {
            if(!toUse && !fakeDataGen){
                fakeDataGen = new FakeDataGen({
                        objectMode: true,
                        configuration: configuration });
                fakeDataGen.pipe(bottleneck);
            }
            debug("Someone connected and I'm starting to provide him data");
            bottleneck.pipe(spark)
        });

        primus.on('disconnection', (spark) => {
            debug("Someone disconnected and he doesn't deserve my data anymore");
            bottleneck.unpipe(spark);
        });

        app.listen(configuration.get('port'), () => {
            debug('HTTP and WebSocket servers ready');
            return callback();
        })
    });
};

parseCommandLine();

let actions = [createStreams, startUp];
let delayed = configuration.get('delayed') || false;

if (delayed) {
        debug('TripleWave is waiting for start');
        actions.shift();
      
        //TODO primus payload here?
    } 

async.series(actions, () => {
    debug('TripleWave ready');      
})