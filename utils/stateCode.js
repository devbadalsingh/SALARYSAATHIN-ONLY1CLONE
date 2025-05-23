export function stateCode(state) {
    let lowerState = state.trim().toLowerCase();
    const code = {
        "andaman and nicobar islands": "AN",
        "andhra pradesh": "AP",
        "arunachal pradesh": "AR",
        assam: "AS",
        bihar: "BR",
        chandigarh: "CH",
        chattisgarh: "CG",
        "dadar and nagar haveli": "DN",
        "daman and diu": "DD",
        delhi: "DL",
        goa: "GA",
        gujarat: "GJ",
        haryana: "HR",
        "himachal pradesh": "HP",
        "jammu and kashmir": "JK",
        jharkhand: "JH",
        karnataka: "KA",
        kerala: "KL",
        "lakshadweep islands": "LD",
        "madhya pradesh": "MP",
        maharashtra: "MH",
        manipur: "MN",
        meghalaya: "ML",
        mizoram: "MZ",
        nagaland: "NL",
        odisha: "OR",
        pondicherry: "PY",
        punjab: "PB",
        rajasthan: "RJ",
        sikkim: "SK",
        "tamil nadu": "TN",
        tripura: "TR",
        "uttar pradesh": "UP",
        uttarakhand: "UK",
        "west bengal": "WB",
        telangana: "TG",
        ladakh: "LA",
    };

    return code[lowerState] || null;
}
