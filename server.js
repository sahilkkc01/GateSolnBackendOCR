const express = require("express");
const axios = require("axios");
const xml2js = require("xml2js");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(express.json());

/* ================= SOCKET SETUP ================= */
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(cors({ origin: "http://localhost:3000" }));

io.on("connection", () => {
  console.log("🟢 Frontend socket connected");
});

/* ================= CONFIG ================= */
const SOAP_URL =
  "http://10.1.100.101:8001/soa-infra/services/default/GateWithEmptyTrailer/emptytrailerbpel_client_ep";

// 🔹 Dummy target API (replace later)
const DUMMY_TARGET_API = "http://localhost:6000/dummy-receiver";

const LOG_DIR = path.join(__dirname, "logs");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);

/* ================= LOG HELPERS ================= */
function writeLog(file, data) {
  const filePath = path.join(LOG_DIR, file);
  let arr = [];

  try {
    if (fs.existsSync(filePath)) {
      const txt = fs.readFileSync(filePath, "utf8");
      arr = txt ? JSON.parse(txt) : [];
    }
  } catch {
    arr = [];
  }

  arr.push({
    timestamp: new Date().toISOString(),
    ...data
  });

  fs.writeFileSync(filePath, JSON.stringify(arr, null, 2));
}

function readLog(file) {
  try {
    const filePath = path.join(LOG_DIR, file);
    if (!fs.existsSync(filePath)) return [];
    const txt = fs.readFileSync(filePath, "utf8");
    return txt ? JSON.parse(txt) : [];
  } catch {
    return [];
  }
}

/* ================= SEND TO TARGET API ================= */
async function sendToTargetAPI(payload) {
  // 🔹 log what is being sent
  writeLog("sent-to-api.log.json", payload);

  // 🔹 dummy call (safe)
  try {
    await axios.post(DUMMY_TARGET_API, payload, { timeout: 5000 });
  } catch (err) {
    // dummy API may not exist – log only
    writeLog("sent-to-api-error.log.json", {
      error: err.message,
      payload
    });
  }
}

function isPermitExpired(isPermitValidTill) {
  if (!isPermitValidTill) return true;
  const permitDate = new Date(isPermitValidTill);
  return permitDate < new Date();
}


/* ================= SOAP ================= */
async function callSoapApi(permitNumber) {
  const soapXml = `
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:ns="http://www.concor.com/cil/EmptyTrailer/1.0/">
  <soapenv:Header/>
  <soapenv:Body>
    <ns:EmptyTrailer>
      <ns:PermitNumber>${permitNumber}</ns:PermitNumber>
    </ns:EmptyTrailer>
  </soapenv:Body>
</soapenv:Envelope>`;

  const res = await axios.post(SOAP_URL, soapXml, {
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      "SOAPAction": "EmptyTrailer"
    }
  });

  return parseSoapResponse(res.data);
}

async function parseSoapResponse(xml) {
  const parsed = await new xml2js.Parser({
    explicitArray: false
  }).parseStringPromise(xml);

  const envKey = Object.keys(parsed).find(k =>
    k.toLowerCase().includes("envelope")
  );
  const bodyKey = Object.keys(parsed[envKey]).find(k =>
    k.toLowerCase().includes("body")
  );

  const output = parsed[envKey][bodyKey].EmptyTrailerOutput;
  const d = output["tns:PermitDTLS"];

  return {
    permitNumber: d["tns:PermitNumber"],
    containerNumber: d["tns:ContainerNumber"],
    containerSize: d["tns:ContainerSize"],
    containerType: d["tns:ContainerType"],
    containerStatus: d["tns:ContainerStatus"],
    vehicleNumber: d["tns:VechileNumber"],
    slineCode: d["tns:SlineCode"],
    lddMtFlag: d["tns:LDD_MT_Flg"]
  };
}

/* ================= MAIN VALIDATION API ================= */
app.post("/api/gate/validate", async (req, res) => {
  try {
    writeLog("incoming.log.json", { body: req.body });

    const client = req.body;

    /* ===== MANUAL CONFIRM FLOW ===== */
    if (client.confirmedByUser === true) {
      const payload = {
        source: "manual",
        client,
        soapData: null,
        timestamp: new Date().toISOString()
      };

      writeLog("matched.log.json", payload);
      await sendToTargetAPI(payload);

      io.emit("gate:matched", payload);

      return res.json({
        success: true,
        message: "Manually confirmed & sent"
      });
    }

    /* ===== SOAP FLOW ===== */
    const soapData = await callSoapApi(client.permitNumber);

    if (isPermitExpired(soapData.isPermitValidTill)) {
  const payload = {
    client,
    soapData,
    reason: "PERMIT_EXPIRED",
    timestamp: new Date().toISOString()
  };

  writeLog("invalid.log.json", payload);
  io.emit("gate:invalid", payload);

  return res.status(422).json({
    success: false,
    type: "INVALID_PERMIT",
    message: "Permit is expired",
    soapData
  });
}

    const mismatches = [];

    if (client.permitNumber !== soapData.permitNumber) {
      mismatches.push({
        field: "permitNumber",
        client: client.permitNumber,
        soap: soapData.permitNumber
      });
    }

    if (
      client.containerNumber &&
      client.containerNumber !== soapData.containerNumber
    ) {
      mismatches.push({
        field: "containerNumber",
        client: client.containerNumber,
        soap: soapData.containerNumber
      });
    }

    /* ===== MATCHED ===== */
    if (mismatches.length === 0) {
      const payload = {
        source: "soap",
        client,
        soapData,
        timestamp: new Date().toISOString()
      };

      writeLog("matched.log.json", payload);
      await sendToTargetAPI(payload);

      io.emit("gate:matched", payload);

      return res.json({
        success: true,
        soapData
      });
    }

    /* ===== MISMATCH ===== */
    writeLog("mismatch.log.json", { client, soapData, mismatches });
    io.emit("gate:mismatch", { client, soapData, mismatches });

    return res.status(409).json({
      success: false,
      mismatches,
      soapData
    });

  } catch (err) {
    writeLog("error.log.json", { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/* ================= FETCH ROUTES ================= */
app.get("/api/gate/matched", (req, res) => {
  const data = readLog("matched.log.json");
  res.json({ success: true, count: data.length, data });
});

app.get("/api/gate/mismatch", (req, res) => {
  const data = readLog("mismatch.log.json");
  res.json({ success: true, count: data.length, data });
});
app.get("/api/gate/invalid", (req, res) => {
  const data = readLog("invalid.log.json");
  res.json({
    success: true,
    count: data.length,
    data
  });
});

/* ================= START ================= */
server.listen(5000, () => {
  console.log(" SOAP Gate Validator running on port 5000");
});
