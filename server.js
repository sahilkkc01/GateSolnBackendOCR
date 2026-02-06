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

/* ================= SOCKET ================= */
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
app.use(cors({ origin: "*" }));

io.on("connection", () => {
  console.log("🟢 Frontend socket connected");
});

/* ================= CONFIG ================= */
const SOAP_URL =
  "http://10.1.100.101:8001/soa-infra/services/default/GateWithEmptyTrailer/emptytrailerbpel_client_ep";

const DUMMY_TARGET_API = "http://localhost:6000/dummy-receiver";

const LOG_DIR = path.join(__dirname, "logs");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);

/* ================= LOG HELPERS ================= */
function writeLog(file, data) {
  const filePath = path.join(LOG_DIR, file);
  let arr = [];

  try {
    if (fs.existsSync(filePath)) {
      arr = JSON.parse(fs.readFileSync(filePath, "utf8") || "[]");
    }
  } catch {
    arr = [];
  }

  arr.push({ timestamp: new Date().toISOString(), ...data });
  fs.writeFileSync(filePath, JSON.stringify(arr, null, 2));
}

function readLog(file) {
  try {
    const filePath = path.join(LOG_DIR, file);
    if (!fs.existsSync(filePath)) return [];
    return JSON.parse(fs.readFileSync(filePath, "utf8") || "[]");
  } catch {
    return [];
  }
}

/* ================= TARGET API ================= */
async function sendToTargetAPI(payload) {
  writeLog("sent-to-api.log.json", payload);

  try {
    await axios.post(DUMMY_TARGET_API, payload, { timeout: 5000 });
  } catch (err) {
    writeLog("sent-to-api-error.log.json", {
      error: err.message,
      payload
    });
  }
}

/* ================= PERMIT EXPIRY ================= */
function isPermitExpired(validTill) {
  if (!validTill) return true;
  return new Date(validTill) < new Date();
}

/* ================= SOAP ================= */
async function callSoapApi(permitNumber) {
  const soapXml = `
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:ns="http://www.concor.com/cil/EmptyTrailer/1.0/">
  <soapenv:Body>
    <ns:EmptyTrailer>
      <ns:PermitNumber>${permitNumber}</ns:PermitNumber>
    </ns:EmptyTrailer>
  </soapenv:Body>
</soapenv:Envelope>`;

  const res = await axios.post(SOAP_URL, soapXml, {
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      SOAPAction: "EmptyTrailer"
    }
  });

  return parseSoapResponse(res.data);
}

async function parseSoapResponse(xml) {
  const parsed = await new xml2js.Parser({ explicitArray: false }).parseStringPromise(xml);

  const env = Object.keys(parsed).find(k => k.toLowerCase().includes("envelope"));
  const body = Object.keys(parsed[env]).find(k => k.toLowerCase().includes("body"));

  const d = parsed[env][body].EmptyTrailerOutput["tns:PermitDTLS"];

  return {
    permitNumber: d["tns:PermitNumber"],
    containerNumber: d["tns:ContainerNumber"],
    vehicleNumber: d["tns:VechileNumber"],
    isPermitValidTill: d["tns:IsPermitValid"]
  };
}

/* ================= VALIDATION ================= */
app.post("/api/gate/validate", async (req, res) => {
  try {
    const client = req.body;
    writeLog("incoming.log.json", client);

    const soapData = await callSoapApi(client.permitNumber);

    /* ===== GLOBAL EXPIRY CHECK ===== */
    if (isPermitExpired(soapData.isPermitValidTill)) {
      const payload = {
        client,
        soapData,
        reason: "PERMIT_EXPIRED"
      };

      writeLog("invalid.log.json", payload);
      io.emit("gate:invalid", payload);

      return res.status(422).json({
        success: false,
        type: "PERMIT_EXPIRED",
        message: "Permit is expired",
        soapData
      });
    }

    const mismatches = [];
    const permit = client.permitNumber || "";
    const prefix = permit.substring(0, 3);
    const gateType = (client.gateType || "").toUpperCase();

    const requireContainer =
      (gateType === "GATE_IN" && prefix === "PMA") ||
      (gateType === "GATE_OUT" && ["PMD", "GPC"].includes(prefix));

    /* ===== VEHICLE CHECK ===== */
    if (!client.vehicleNumber) {
      mismatches.push({
        field: "vehicleNumber",
        reason: "Vehicle number missing from validate payload"
      });
    } else if (
      soapData.vehicleNumber &&
      client.vehicleNumber !== soapData.vehicleNumber
    ) {
      mismatches.push({
        field: "vehicleNumber",
        client: client.vehicleNumber,
        soap: soapData.vehicleNumber
      });
    }

    /* ===== CONTAINER CHECK ===== */
    if (requireContainer) {
      if (
        client.containerNumber &&
        soapData.containerNumber &&
        client.containerNumber !== soapData.containerNumber
      ) {
        mismatches.push({
          field: "containerNumber",
          client: client.containerNumber,
          soap: soapData.containerNumber
        });
      }
    }

    /* ===== FINAL DECISION ===== */
    if (mismatches.length === 0) {
      const payload = {
        source: "soap",
        client,
        soapData
      };

      writeLog("matched.log.json", payload);
      await sendToTargetAPI(payload);
      io.emit("gate:matched", payload);

      return res.json({ success: true, soapData });
    }

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

/* ================= FETCH ================= */
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
  res.json({ success: true, count: data.length, data });
});

/* ================= START ================= */
server.listen(5000, () => {
  console.log("🚦 SOAP Gate Validator running on port 5000");
});
