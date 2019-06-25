/*
 * @fileOverview Main testing helper lib.
 */
var axios = require('axios');
var Promise = require('bluebird');
var bunyan = require('bunyan');

var fmt = require('bunyan-format');

// override to enable logging
process.env.KAFKA_AVRO_LOG_LEVEL = 'debug';

var KafkaAvro = require('../..');

var schemaFix = require('../fixtures/schema.fix');

var schemaTwoFix = require('../fixtures/schema-two.fix');

var keySchemaFix = require('../fixtures/key-schema.fix');

var testLib = module.exports = {};

testLib.log = bunyan.createLogger({
  name: 'KafkaAvroTest',
  level: 'trace',
  stream: fmt({
    outputMode: 'long',
    levelInString: true,
  }),
});

testLib.KAFKA_SCHEMA_REGISTRY_URL = 'http://localhost:8081';
testLib.KAFKA_BROKER_URL = 'kafka:9092';

testLib.topic = schemaFix.name;
testLib.topicTwo = schemaTwoFix.name;
testLib.topicThreeWithDuplicateSchema = schemaFix.name + '-duplicateSchema';

var testBoot = false;

/**
 * Require from all test scripts, prepares kafka for testing.
 *
 */
testLib.init = function() {
  beforeEach(function() {
    if (testBoot) {
      return;
    }
    testBoot = true;

    this.timeout(180000); // wait up to 3' for the SR to come up

    return Promise.all([
      testLib.registerSchema(testLib.topic, schemaFix, 'value'),
      testLib.registerSchema(testLib.topicTwo, schemaTwoFix, 'value'),
      testLib.registerSchema(testLib.topicThreeWithDuplicateSchema, schemaFix, 'value'),

      testLib.registerSchema(testLib.topic, keySchemaFix, 'key'),
      testLib.registerSchema(testLib.topicTwo, keySchemaFix, 'key'),
      testLib.registerSchema(testLib.topicThreeWithDuplicateSchema, keySchemaFix, 'key'),
    ]);
  });

  beforeEach(function() {
    let kafkaAvro = new KafkaAvro({
      kafkaBroker: testLib.KAFKA_BROKER_URL,
      schemaRegistry: testLib.KAFKA_SCHEMA_REGISTRY_URL,
      log: testLib.log
    });

    testLib.log.info('test.beforeEach 2: Invoking kafkaAvro.init()...');

    return kafkaAvro.init()
      .then(() => {
        testLib.log.info('test.beforeEach 2: kafkaAvro.init() done!');
        this.kafkaAvro = kafkaAvro;
        this.sr = kafkaAvro.sr;
      });
  });
};

/**
 * Register a schema on SR.
 *
 * @param {string} The topic.
 * @param {schema} Object The schema to register.
 * @param {number=} retries how many times has retried.
 * @return {Promise} A Promise.
 */
testLib.registerSchema = Promise.method(function(topic, schema, type, retries) {
  var schemaCreateUrl = testLib.KAFKA_SCHEMA_REGISTRY_URL +
    '/subjects/' + topic + '-' + type + '/versions';

  var data = {
    schema: JSON.stringify(schema),
  };

  retries = retries || 0;

  testLib.log.info('TEST :: Registering schema:', topic, 'on SR:', schemaCreateUrl);

  return axios({
    url: schemaCreateUrl,
    method: 'post',
    headers: {
      'Content-Type': 'application/vnd.schemaregistry.v1+json',
    },
    data: data,
  })
    .catch(function(err) {
      testLib.log.error('Axios SR creation failed:', retries, err.message);
      retries++;
      return new Promise(function(resolve) {
        setTimeout(function() {
          testLib.registerSchema(topic, schema, type, retries)
            .then(resolve);
        }, 1000);
      });
    });
});

/**
 * Have a Cooldown period between tests.
 *
 * @param {number} seconds cooldown in seconds.
 * @return {Function} use is beforeEach().
 */
testLib.cooldown = function(seconds) {
  return function(done) {
    setTimeout(done, seconds);
  };
};
