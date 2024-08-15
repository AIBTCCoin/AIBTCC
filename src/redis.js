const redis = require('redis');
const { promisify } = require('util');

// Create a Redis client
const client = redis.createClient();

// Promisify Redis client methods for async/await usage
const setAsync = promisify(client.set).bind(client);
const getAsync = promisify(client.get).bind(client);
const delAsync = promisify(client.del).bind(client);
const lpushAsync = promisify(client.lpush).bind(client);
const lrangeAsync = promisify(client.lrange).bind(client);

module.exports = {
  setAsync,
  getAsync,
  delAsync,
  lpushAsync,
  lrangeAsync,
  client,
};
