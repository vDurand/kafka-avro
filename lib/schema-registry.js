/**
 * @fileOverview Queries the Schema Registry for all schemas and evaluates them.
 */
var URL = require('url').URL;

var Promise = require('bluebird');
var cip = require('cip');
var axios = require('axios');
var avro = require('avsc');
var instance = axios;

/**
 * Queries the Schema Registry for all schemas and evaluates them.
 *
 * @param {Object} opts Options to initialize the SR module with:
 *   @param {string} schemaRegistryUrl The SR url.
 *   @param {Array.<string>|null} selectedTopics Selected topics to fetch if defined.
 *   @param {boolean} fetchAllVersions Fetch all past versions for each topic.
 *   @param {?Object} parseOptions Schema parsing options to pass to avro.parse().
 * @constructor
 */
var SchemaRegistry = module.exports = cip.extend(function(opts) {
  if (opts.httpsAgent) {
    instance = axios.create({httpsAgent: opts.httpsAgent});
  }
  /** @type {bunyan.Logger} Parent bunyan logger. */
  this.log = opts.log;

  /** @type {Object} The SR URL object */
  this.schemaRegistryUrl = new URL(opts.schemaRegistryUrl + (opts.schemaRegistryUrl.endsWith('/') ? '' : '/'));

  /** @type {Array.<string>|null} The user selected topics to fetch, can be null */
  this.selectedTopics = opts.selectedTopics;

  /** @type {boolean} Fetch all versions for each topic. */
  this.fetchAllVersions = opts.fetchAllVersions;

  /** @type {?Array.<string>} List of schema topics with -value, -key annotations */
  this.schemaTopics = null;

  /** @type {?Object} Schema parsing options to pass to avro.parse() */
  this.parseOptions = opts.parseOptions || {};
  if (this.parseOptions.wrapUnions === undefined) {
    this.parseOptions.wrapUnions = true;
  }

  /** @type {?Number} The refresh time (in seconds) that the schema registry will be fetch */
  this.fetchRefreshRate = opts.fetchRefreshRate;

  /**
   * A dict containing all the value schemas with key the bare topic name and
   * value the instance of the "avsc" package.
   *
   * @type {Object}
   */
  this.valueSchemas = {};

  /**
   * A dict containing all the key schemas with key the bare topic name and
   * value the instance of the "avsc" package.
   *
   * @type {Object}
   */
  this.keySchemas = {};

  /**
   * A dict containing all the value schemas metadata, with key the bare
   * topic name and value the SR response on that topic:
   *
   * 'subject' {string} The full topic name, including the '-value' suffix.
   * 'version' {number} The version number of the schema.
   * 'id' {number} The schema id.
   * 'schema' {string} JSON serialized schema.
   *
   * @type {Object}
   */
  this.schemaMeta = {};

  /**
   * A dict containing the instance of the "avsc" package, and key the SR schema id.
   *
   * @type {Object}
   */
  this.schemaTypeById = {};


  /**
   * A dict containing the schema ids for keys and values.
   *
   * @type {Object}
   */
  this.schemaIds = {};
});

/**
 * Get the avro RecordType from a schema response.
 *
 * @return {RecordType} An avro RecordType representing the parsed avro schema.
 */
function typeFromSchemaResponse(schema, parseOptions) {
  var schemaType = avro.parse(schema);
  
  //check if the schema has been previouisly parsed and added to the registry
  if(typeof parseOptions.registry === 'object' && typeof parseOptions.registry[schemaType.name] !== 'undefined'){
    return parseOptions.registry[schemaType.name];
  }

  return avro.parse(schema, parseOptions);
}

/**
 * Initialize the library, fetch schemas and register them locally.
 *
 * @return {Promise(Array.<Object>)} A promise with the registered schemas.
 */
SchemaRegistry.prototype.init = Promise.method(function () {
  this.log.info('init() :: Initializing SR, will fetch all schemas from SR...');
  if (this.fetchRefreshRate > 0) {
    this._refreshHandle = setInterval(this._fetchSchemas.bind(this), this.fetchRefreshRate * 1000);
  }
  return this._fetchSchemas();
});

/**
 * After the initial schema registration is complete check if it is required to
 * fetch all the past versions for each topic and concatenate those results.
 *
 * @param {Array.<Object>} registeredSchemas The registered schemas from the first op.
 * @return {Promise(Array.<Object>)} The same schemas plus all the versions if requested.
 * @private
 */
SchemaRegistry.prototype._checkForAllVersions = Promise.method(
  function (registeredSchemas) {
    if (!this.fetchAllVersions) {
      return registeredSchemas;
    }

    // Fetch and register all past versions for each schema.
    return Promise.resolve(this.schemaTopics)
      .bind(this)
      .map(this._fetchAllSchemaVersions, {concurrency: 10})
      .filter(Boolean)
      .then(this._flatenResults)
      .map(this._fetchSchema, {concurrency: 10})
      .map(this._registerSchema)
      .then(function (allRegisteredSchemas) {
        return registeredSchemas.concat(allRegisteredSchemas);
      });
  });

/**
 * Flatten the array of arrays produced by _fetchAllSchemaVersions().
 *
 * @param {Array.<Array.<Object>>} results Results as produced by _fetchAllSchemaVersions().
 * @return {Promise(Array.<Object>)} Flattened results.
 * @private
 */
SchemaRegistry.prototype._flatenResults = Promise.method(function (results) {
  var flattenedResults = [];
  results.map(function (schemaVersions) {
    schemaVersions.forEach(function (schemaVersion) {
      flattenedResults.push(schemaVersion);
    });
  });

  return flattenedResults;
});

/**
 * A master wrapper method to determine if all topics or just specific ones
 * need to be fetched.
 *
 * @return {Promise(Array.<string>)} A Promise with an arrray of string topics.
 * @private
 */
SchemaRegistry.prototype._fetchTopics = Promise.method(function () {
  if (this.selectedTopics) {
    return this._processSelectedTopics();
  } else {
    return this._fetchAllSchemaTopics();
  }
});

/**
 * Will store the topics to fetch schemas for, including the -value, -key
 * annotations.
 *
 * @param {Array.<string>} schemaTopics An array of all the schema topics.
 * @return {Promise(Array.<string>)} A Promise with the input as is.
 * @private
 */
SchemaRegistry.prototype._storeTopics = Promise.method(function (schemaTopics) {
  this.schemaTopics = schemaTopics;
  return schemaTopics;
});

/**
 * Process the selected topics so as to append `-value` and `-key` values.
 *
 * @return {Array.<string>} An array of properly formated strings to be used as
 *   topics when fetching the schemas.
 * @private
 */
SchemaRegistry.prototype._processSelectedTopics = Promise.method(function () {
  var topics = [];

  this.selectedTopics.forEach(function (selectedTopic) {
    topics.push(selectedTopic + '-value');
    topics.push(selectedTopic + '-key');
  });

  return topics;
});

/**
 * Fetch all registered schema topics from SR.
 *
 * @return {Promise(Array.<string>)} A Promise with an arrray of string topics.
 * @private
 */
SchemaRegistry.prototype._fetchAllSchemaTopics = Promise.method(function () {

  var fetchAllTopicsUrl = new URL('subjects', this.schemaRegistryUrl).toString();

  this.log.debug('_fetchAllSchemaTopics() :: Fetching all schemas using url:',
    fetchAllTopicsUrl);

  return Promise.resolve(instance.get(fetchAllTopicsUrl))
    .bind(this)
    .then((response) => {
      this.log.info('_fetchAllSchemaTopics() :: Fetched total schemas:',
        response.data.length);
      return response.data;
    })
    .catch(this._suppressAxiosError);
});

/**
 * Fetch just the latest version for a topic from the SR.
 *
 * @param {string} schemaTopic The topic to fetch the latest versionf for.
 * @return {Promise(Object)} A Promise with an object containing the
 *   topic name and version number.
 * @private
 */
SchemaRegistry.prototype._fetchLatestVersion = Promise.method(function (schemaTopic) {
  var fetchLatestVersionUrl = new URL(
    'subjects/' + schemaTopic + '/versions/latest',
    this.schemaRegistryUrl
  ).toString();

  this.log.debug('_fetchLatestVersion() :: Fetching latest topic version from url:',
    fetchLatestVersionUrl);

  return Promise.resolve(instance.get(fetchLatestVersionUrl))
    .then((response) => {
      this.log.debug('_fetchLatestVersion() :: Fetched latest topic version from url:',
        fetchLatestVersionUrl);

      return {
        version: response.data.version,
        schemaTopic: schemaTopic,
      };
    })
    .catch(this._suppressAxiosError);
});


/**
 * Fetch all available versions for a subject from the SR.
 *
 * @return {Promise(Array.<Object>)} A Promise with an array of objects
 *   containing the topic name and version number.
 * @private
 */
SchemaRegistry.prototype._fetchAllSchemaVersions = Promise.method(function (schemaTopic) {
  var fetchVersionsUrl = new URL(
    'subjects/' + schemaTopic + '/versions',
    this.schemaRegistryUrl
  ).toString();

  this.log.debug('_fetchAllSchemaVersions() :: Fetching schema versions:',
    fetchVersionsUrl);

  return Promise.resolve(instance.get(fetchVersionsUrl))
    .then((response) => {
      this.log.debug('_fetchAllSchemaVersions() :: Fetched schema versions:',
        fetchVersionsUrl);

      return response.data.map(version => ({
        version: version,
        schemaTopic: schemaTopic,
      }));
    })
    .catch(this._suppressAxiosError);
});

/**
 * Fetch a single schema from the SR and return its value along with metadata.
 *
 * @param {Object} topicMeta An object containing the version
 * @return {Promise(Array.<Object>)} A Promise with an array of objects,
 *   see return statement bellow for return schema.
 * @private
 */
SchemaRegistry.prototype._fetchSchema = Promise.method(function (topicMeta) {
  var schemaTopic = topicMeta.schemaTopic;
  var version = topicMeta.version;
  var parts = schemaTopic.split('-');
  var schemaType = parts.pop();
  var topic = parts.join('-');

  var fetchSchemaUrl = new URL(
    'subjects/' + schemaTopic + '/versions/' + version,
    this.schemaRegistryUrl
  ).toString();

  this.log.debug('_fetchSchema() :: Fetching schema url:',
    fetchSchemaUrl);

  return Promise.resolve(instance.get(fetchSchemaUrl))
    .then((response) => {
      this.log.debug('_fetchSchema() :: Fetched schema url:',
        fetchSchemaUrl);

      return {
        version: version,
        responseRaw: response.data,
        schemaType: schemaType,
        schemaTopicRaw: schemaTopic,
        topic: topic,
      };
    })
    .catch(this._handleAxiosError);
});

/**
 * Register the provided schema locally using avro.
 *
 * @param {Object} schemaObj Schema object as produced by _fetchSchema().
 * @return {Promise(Array.<Object>)} A Promise with the object received
 *   augmented with the "type" property which stores the parsed avro schema.
 * @private
 */
SchemaRegistry.prototype._registerSchema = Promise.method(function (schemaObj) {
  this.log.debug('_registerSchema() :: Registering schema:',
    schemaObj.topic);

  try {
    schemaObj.type = typeFromSchemaResponse(schemaObj.responseRaw.schema, this.parseOptions);
  } catch(ex) {
    this.log.warn('_registerSchema() :: Error parsing schema:',
      schemaObj.schemaTopicRaw, 'Error:', ex.message, 'Moving on...');
    return schemaObj;
  }

  this.log.debug('_registerSchema() :: Registered schema:', schemaObj.topic);

  if (schemaObj.schemaType.toLowerCase() === 'value') {
    this.schemaTypeById['schema-' + schemaObj.responseRaw.id] = schemaObj.type;
  }

  return schemaObj;
});

/**
 * Register the latest schema version locally using avro.
 *
 * @param {Object} schemaObj Schema object as produced by _fetchSchema().
 * @return {Promise(Array.<Object>)} A Promise with the object received
 *   augmented with the "type" property which stores the parsed avro schema.
 * @private
 */
SchemaRegistry.prototype._registerSchemaLatest = Promise.method(function (schemaObj) {
  this.log.debug('_registerSchemaLatest() :: Registering schema:',
    schemaObj.topic);

  try {
    schemaObj.type = typeFromSchemaResponse(schemaObj.responseRaw.schema, { wrapUnions: true });
  } catch (ex) {
    this.log.warn('_registerSchemaLatest() :: Error parsing schema:',
      schemaObj.schemaTopicRaw, 'Error:', ex.message, 'Moving on...');
    return schemaObj;
  }

  this.log.debug('_registerSchemaLatest() :: Registered schema:', schemaObj.topic);

  if (schemaObj.schemaType.toLowerCase() === 'value') {
    this.schemaTypeById['schema-' + schemaObj.responseRaw.id] = schemaObj.type;
    this.valueSchemas[schemaObj.topic] = schemaObj.type;
    this.schemaIds[schemaObj.topic + '-value'] = schemaObj.responseRaw.id;
  } else {
    this.keySchemas[schemaObj.topic] = schemaObj.type;
    this.schemaIds[schemaObj.topic + '-key'] = schemaObj.responseRaw.id;
  }
  this.schemaMeta[schemaObj.topic] = schemaObj.responseRaw;
  return schemaObj;
});

/**
 * Handle axios (http) error.
 *
 * @param {Error} err The error.
 * @private
 * @throws Error whatever is passed.
 */
SchemaRegistry.prototype._handleAxiosError = function (err) {
  if (!err.port) {
    // not an axios error, bail early
    throw err;
  }

  this.log.warn('_handleAxiosError() :: http error:', err.message,
    'Url:', err.config.url);

  throw err;
};


/**
 * Suppress axios (http) error.
 *
 * @param {Error} err The error.
 * @throws Error if not from axios.
 * @return {null} empty response.
 * @private
 */
SchemaRegistry.prototype._suppressAxiosError = function (err) {
  if (!err.response) {
    // not an axios error, bail early
    throw err;
  }

  this.log.debug('_suppressAxiosError() :: http error, will continue operation.',
    'Error:', err.message, 'Url:', err.config.url);

  return null;
};

/**
 * Fetch schemas and register them locally.
 *
 * @return {Promise(Array.<Object>)} A promise with the registered schemas.
 * @private
 */
SchemaRegistry.prototype._fetchSchemas = function () {
  this.log.debug('_fetchSchemas() :: Schemas refreshed');
  return this._fetchTopics()
    .bind(this)
    .then(this._storeTopics)
    .map(this._fetchLatestVersion, { concurrency: 10 })
    .filter(Boolean)
    .map(this._fetchSchema, { concurrency: 10 })
    .map(this._registerSchemaLatest)
    .then(this._checkForAllVersions);
};
