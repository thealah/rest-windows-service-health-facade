var securityFilter = require('./securityFilter'),
  express = require('express'),
  nconf = require('nconf'),
  path = require('path'),
  lazy = require("lazy"),
  os = require("os"),
  childProcess = require('child_process'),
  app = express();

nconf.argv().env();
nconf.file(path.join(__dirname, "config.json"));
nconf.load();

var host = os.hostname();

var badRequest = function (res, reason) {
    reason = "The data you sent was invalid. " + (reason || "");
    res.hasEnded = true;
    res.status(500).send(reason).end();
};

var stripWindowsServiceCLILine = function (ioLine) {
  ioLine = ioLine.trim();
  switch (ioLine) {
    case "These Windows services are started:":
    case "The command completed successfully.": return "";
    default: return ioLine;
  }
};

var getServices = function (filter, callback) {
  var child = childProcess.spawn("net", ['start']);
  var errData = '';
  var services = [];
  child.stderr.on('data', function (chunk){
    errData += chunk;
  });
  child.on('exit', function () {
    if (errData) {
      console.log(errData);
      return callback(errData, []);
    }

    callback(undefined, services);
  });

  lazy(child.stdout)
    .lines
    .map(String)
    .skip(2)
    .map(stripWindowsServiceCLILine)
    .filter(function (service){
      return  service && 
              securityFilter.isServiceAllowed(service) && 
              (!filter || service.toLowerCase() === filter.toLowerCase());
    })
    .forEach(function(service){
      services.push(service);
    });
};

var parseIisDetails = function (iisStatusString) {
  var startOfString = "SITE \"";
  var startsWithSite = iisStatusString.indexOf(startOfString) === 0;

  if (startsWithSite) {
    var endOfName = iisStatusString.indexOf("\"", startOfString.length);
    var name = iisStatusString.substring(startOfString.length, endOfName);
    var firstParenthesis = iisStatusString.indexOf("(");
    var lastParenthesis = iisStatusString.lastIndexOf(")");
    var remainingProperties = iisStatusString.substring(firstParenthesis + 1, lastParenthesis);
    var pairings = remainingProperties.split(',');
    var properties = {};
    for(var i=0; i<pairings.length; i++) {
      var kvp = pairings[i].split(':');
      properties[kvp[0]] = kvp[1];
    }
    properties.name = name;

    return properties;
  }

  return undefined;
};

var stripIisSiteLine = function (ioLine) {
  ioLine = ioLine.trim();
  return parseIisDetails(ioLine);
};

var getIisWebsites = function (siteFilter, callback) {
  var args = ['list', 'site'];
  if (siteFilter) {
    args.push('/name:' + siteFilter);
  }
  else {
    //Only show started IIS apps in the /iis route
    args.push('/state:started');
  }
  var child = childProcess.spawn(path.join(process.env.systemroot, 'system32', 'inetsrv', 'appcmd.exe'), args);
  var errData = '';
  var websites = [];
  child.stderr.on('data', function (chunk){
    errData += chunk;
  });
  child.on('exit', function () {
    if (errData) {
      console.log(errData);
      return callback(errData, []);
    }

    callback(undefined, websites);
  });

  lazy(child.stdout)
    .lines
    .map(String)
    .map(stripIisSiteLine)
    .filter(function (website){
      return  website && 
              website.name &&
              securityFilter.isWebsiteAllowed(website.name);
    })
    .forEach(function(website){
      websites.push(website);
    });
};

app.get('/iis/info/:site', function (req, res) {
  if (!securityFilter.isWebsiteAllowed(req.params.site)) {
    res.end();
    return;
  }

  var port = server.address().port;

  res.jsonp({
    "description": "IIS Website is monitored by a REST API - https://github.com/thealah/rest-windows-service-health-facade",
    "website": req.params.site,
    "host": host,
    "healthCheckHost": host,
    "healthCheckPort": port,
    "ui": {
      "hide": ["healthCheckHost", "healthCheckPort"]
    }
  });
  res.end();
});

app.get('/iis/:site', function (req, res) {
  var siteFilter = req.params.site;
  if (!siteFilter || /^[a-zA-Z0-9- \.]+$/.test(siteFilter) == false) {
    badRequest(res, "Invalid Site Name");
    return;
  }

  getIisWebsites(siteFilter, function (err, websites) {
    if (err) {
      res.status(500).jsonp({
        "type": "Website",
        "host": host,
        "message": "Error reading IIS Websites",
        "ui": {
          "info": "/iis/info/" + encodeURIComponent(siteFilter)
        }
      });
    }
    else if (!websites.length) {
      res.status(502).jsonp({
        "type": "Website",
        "host": host,
        "message": "Missing Website '" + siteFilter + "'",
        "ui": {
          "info": "/iis/info/" + encodeURIComponent(siteFilter)
        }
      });
    }
    else {
      if (websites[0].state !== 'Started') {
        res.status(502);
      }
      res.jsonp({
        "type": "Website",
        "host": host,
        "iisStatus": websites[0].state,
        "bindings": websites[0].bindings,
        "ui": {
          "info": "/iis/info/" + encodeURIComponent(siteFilter)
        }
      });
    }
    res.end();
  });
});

app.get('/iis', function (req, res) {
  getIisWebsites(undefined, function (err, websites) {
    if (err) {
      res.status(500);
    }
    else {
      res.jsonp({
        "services": websites,
        "host": host,
        "message": "To use the healthcheck portion of the API, use the route: /iis/$IIS_SITE_NAME"
      }); 
    }
    res.end();
  });
});

app.get('/info/:service', function (req, res) {
  if (!securityFilter.isServiceAllowed(req.params.service)) {
    res.end();
    return;
  }
  var port = server.address().port;

  res.jsonp({
    "description": "Windows Service is monitored by a REST API - https://github.com/thealah/rest-windows-service-health-facade",
    "windowsService": req.params.service,
    "host": host,
    "healthCheckHost": host,
    "healthCheckPort": port,
    "ui": {
      "hide": ["healthCheckHost", "healthCheckPort"]
    }
  });
  res.end();
});

app.get('/:service', function (req, res) {
  var serviceFilter = req.params.service;
  if (!serviceFilter) {
    badRequest(res, "Invalid Service Name");
    return;
  }

  getServices(serviceFilter, function (err, services) {
    if (err) {
      res.status(500).jsonp({
        "type": "Windows Service",
        "host": host,
        "message": "Error reading Windows Services",
        "ui": {
          "info": "/info/" + encodeURIComponent(serviceFilter)
        }
      });
    }
    else if (!services.length) {
      res.status(502).jsonp({
        "type": "Windows Service",
        "host": host,
        "message": "Missing Windows Service '" + serviceFilter + "' or it is stopped",
        "ui": {
          "info": "/info/" + encodeURIComponent(serviceFilter)
        }
      });
    }
    else {
      res.jsonp({
        "type": "Windows Service",
        "host": host,
        "ui": {
          "info": "/info/" + encodeURIComponent(services[0])
        }
      });
    }
    res.end();
  });
});

app.get('/', function (req, res) {
  getServices(undefined, function (err, services) {
    if (err) {
      res.status(500);
    }
    else {
      res.jsonp({
        "services": services,
        "host": host,
        "message": "To use the healthcheck portion of the API, use the route: /$WINDOWS_SERVICE_NAME"
      }); 
    }
    res.end();
  });
});

var server = app.listen(nconf.get('port') || 3000, function () {
  var port = server.address().port;

  console.log('Windows Service HealthCheck REST API listening on port %s', port);
});

if (nconf.get('alternatePort')) {
  var alternateServer = app.listen(nconf.get('alternatePort') || 3000, function () {
    var port = alternateServer.address().port;

    console.log('Windows Service HealthCheck REST API listening on port %s', port);
  });
}