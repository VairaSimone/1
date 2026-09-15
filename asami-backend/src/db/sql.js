function jsonParam(value) {
  return value == null ? null : JSON.stringify(value);
}

function uuidExpr(column = "?") {
  return `UUID_TO_BIN(${column})`;
}

module.exports = { jsonParam, uuidExpr };
