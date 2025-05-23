import mongoose from "mongoose";
import "dotenv/config.js";
import Application from "../models/Applications.js";
import CamDetails from "../models/CAM.js";
import Closed from "../models/Closed.js";
import Disbursal from "../models/Disbursal.js";
import Lead from "../models/Leads.js";
import Documents from "../models/Documents.js";
import AadhaarDetails from "../models/AadhaarDetails.js";
import Sanction from "../models/Sanction.js";
import Employee from "../models/Employees.js";
import moment from "moment-timezone";
import xlsx from "xlsx";
import fs from "fs";
import Bank from "../models/ApplicantBankDetails.js";
import { formatFullName } from "./nameFormatter.js";
import { nextSequence } from "../utils/nextSequence.js";
import LeadStatus from "../models/LeadStatus.js";
import S3 from "aws-sdk/clients/s3.js";
import { sanctionLetter } from "./sanctionLetter.js";

const mongoURI = process.env.MONGO_URI;

const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
const region = process.env.AWS_REGION;
const BUCKET_NAME = process.env.AWS_BUCKET_NAME;

const s3 = new S3({ region, accessKeyId, secretAccessKey });

// MongoDB Connection
async function connectToDatabase() {
    try {
        await mongoose.connect(mongoURI);
        console.log("Connected to the database!");
    } catch (error) {
        console.error("Database connection failed:", error);
        process.exit(1); // Exit the process on failure
    }
}

// Function to migrate recommended applications to sanction collection.
const migrateApplicationsToSanctions = async () => {
    try {
        const applications = await Application.find({ isRecommended: true });

        for (const application of applications) {
            const existingSanction = await Sanction.findOne({
                application: application._id,
            });

            if (!existingSanction) {
                const newSanctionData = {
                    application: application._id,
                    recommendedBy: application.recommendedBy,
                    isChanged: true,
                };

                // Populate sanction data based on application conditions
                if (application.isApproved) {
                    newSanctionData.isApproved = true;
                    newSanctionData.approvedBy = application.approvedBy; // Assuming recommendedBy holds approval info
                    newSanctionData.sanctionDate = application.sanctionDate;
                    // console.log("New Sanction: ", newSanctionData);
                }

                // Create the new Sanction document
                const newSanction = new Sanction(newSanctionData);
                await newSanction.save();
                // console.log(newSanction);

                console.log(
                    `Created sanction for application ID: ${application._id}`
                );
            } else {
                console.log(
                    `Sanction already exists for application ID: ${application._id}`
                );
            }
        }

        console.log("Migration completed");
    } catch (error) {
        console.error("Error during migration:", error);
    } finally {
        await mongoose.disconnect();
        console.log("Disconnected from MongoDB");
    }
};

// Function to replace application field to sanction field in Disbursal records.
const updateDisbursals = async () => {
    try {
        // Find all disbursals that have an `application` field instead of `sanction`
        const disbursalsWithApplication = await Disbursal.find({
            application: { $exists: true },
        });
        console.log(disbursalsWithApplication);

        for (const disbursal of disbursalsWithApplication) {
            const applicationId = disbursal.application;
            console.log(applicationId);

            // Find the corresponding Sanction document by application ID
            const sanction = await Sanction.findOne({
                application: applicationId,
            });

            if (sanction) {
                // Update disbursal with the found sanction ID and remove the application field
                disbursal.sanction = sanction._id;
                disbursal.application = undefined; // Remove the application field

                // Save the updated disbursal document
                await disbursal.save();
                console.log(
                    `Updated disbursal with ID: ${disbursal._id}, replaced application with sanction ID.`
                );
            } else {
                console.log(
                    `No sanction found for application ID: ${applicationId}. Disbursal ID: ${disbursal._id} remains unchanged.`
                );
            }
        }

        console.log("Migration completed.");
    } catch (error) {
        console.error("Error during migration:", error);
    } finally {
        await mongoose.disconnect();
        console.log("Disconnected from MongoDB");
    }
};

// Function to add recommendedBy to sanction records.
const addRecommendedByToSanctions = async () => {
    try {
        // Fetch all sanctions that might be missing recommendedBy
        const sanctions = await Sanction.find({
            recommendedBy: { $exists: false },
        });

        for (const sanction of sanctions) {
            // Find the corresponding Application document
            const application = await Application.findById(
                sanction.application
            );

            if (application) {
                // Update the Sanction document with the recommendedBy field from Application
                sanction.recommendedBy = application.recommendedBy;

                // Save the updated sanction document
                await sanction.save();
                console.log(
                    `Updated sanction for application ID: ${application._id} with recommendedBy: ${application.recommendedBy}`
                );
            } else {
                console.log(
                    `No corresponding application found for sanction ID: ${sanction._id}`
                );
            }
        }

        console.log("Field update completed");
    } catch (error) {
        console.error("Error during field update:", error);
    } finally {
        await mongoose.disconnect();
        console.log("Disconnected from MongoDB");
    }
};

const matchPANFromExcel = async () => {
    try {
        // Load the Excel file
        const workbook = xlsx.readFile("Speedoloan-disbursal.xlsx"); // replace with your file path
        const sheetName = workbook.SheetNames[0]; // assuming data is in the first sheet
        const sheet = workbook.Sheets[sheetName];

        const range = xlsx.utils.decode_range(sheet["!ref"]);

        // Extract PAN numbers from column B, starting at row 2
        const panNumbers = [];

        for (let row = 1; row <= range.e.r; row++) {
            // row 1 corresponds to D2
            const cellAddress = `D${row + 1}`;
            const cell = sheet[cellAddress];
            if (cell && cell.v) {
                const cleanedPanNumber = cell.v.replace(/\s+/g, "");
                // Check if the cell exists and has a value
                panNumbers.push(cleanedPanNumber);
            }
        }

        let leadCount = 0;
        let applicationCount = 0;
        let sanctionCount = 0;
        let sanctionedCount = 0;

        let leads = [];
        let applications = [];
        let sanctions = [];
        let sanctioned = [];

        for (const panNumber of panNumbers) {
            // Check if PAN exists in the Lead collection
            const lead = await Lead.findOne({
                pan: String(panNumber),
            }).populate({ path: "recommendedBy", select: "fName mName lName" });

            if (lead) {
                const application = await Application.findOne({
                    lead: lead._id,
                }).populate([
                    { path: "lead" },
                    { path: "recommendedBy", select: "fName mName lName" },
                ]);

                if (application) {
                    const sanction = await Sanction.findOne({
                        application: application._id,
                    }).populate([
                        { path: "application", populate: { path: "lead" } },
                        { path: "recommendedBy", select: "fName mName lName" },
                    ]);
                    if (sanction?.isApproved) {
                        sanctionedCount += 1;
                        sanctioned.push(
                            // `${sanction.application.lead.fName}${
                            //     sanction.application.lead.mName &&
                            //     ` ${sanction.application.lead.mName}`
                            // }${
                            //     sanction.application.lead.lName &&
                            //     ` ${sanction.application.lead.lName}`
                            // }, ${sanction.application.lead.mobile}, ${
                            //     sanction.application.lead.pan
                            // }`
                            `${sanction._id.toString()}`
                        );
                    } else if (sanction) {
                        sanctionCount += 1;
                        sanctions.push(
                            // `${sanction.application.lead.fName}${
                            //     sanction.application.lead.mName &&
                            //     ` ${sanction.application.lead.mName}`
                            // }${
                            //     sanction.application.lead.lName &&
                            //     ` ${sanction.application.lead.lName}`
                            // }, ${sanction.application.lead.mobile}, ${
                            //     sanction.application.lead.pan
                            // }`
                            `${sanction._id.toString()}`
                        );
                    } else {
                        applicationCount += 1;
                        applications.push(
                            // `${application.lead.fName}${
                            //     application.lead.mName &&
                            //     ` ${application.lead.mName}`
                            // }${
                            //     application.lead.lName &&
                            //     ` ${application.lead.lName}`
                            // }, ${application.lead.mobile}, ${
                            //     application.lead.pan
                            // }`
                            `${application._id.toString()}`
                        );
                    }
                } else {
                    leadCount += 1;
                    leads.push(
                        // `${lead.fName}${lead.mName && ` ${lead.mName}`}${
                        //     lead.lName && ` ${lead.lName}`
                        // }, ${lead.mobile}, ${lead.pan}`
                        `${lead._id.toString()}`
                    );
                }
            } else {
                console.log(`No lead found for PAN ${panNumber}`);
            }
        }
        // Prepare data for Excel with leads in column A, applications in column B, and sanctions in column C
        const maxLength = Math.max(
            leads.length,
            applications.length,
            sanctions.length
        );
        const data = [
            ["Lead", "Application", "Sanction", "Sanctioned"], // Header row
            ...Array.from({ length: maxLength }, (_, i) => [
                leads[i] || "", // Column A
                applications[i] || "", // Column B
                sanctions[i] || "", // Column C
                sanctioned[i] || "", // Column D
            ]),
        ];

        // Create a new workbook and worksheet
        const newWorkbook = xlsx.utils.book_new();
        const newWorksheet = xlsx.utils.aoa_to_sheet(data);

        // Append the worksheet to the workbook
        xlsx.utils.book_append_sheet(newWorkbook, newWorksheet, "PAN Results");

        // Write the workbook to a file
        xlsx.writeFile(newWorkbook, "PAN_Matching_Results.xlsx");

        console.log(
            "PAN matching process completed and results saved to Excel"
        );
    } catch (error) {
        console.error("Error during PAN matching:", error);
    } finally {
        // Disconnect from MongoDB
        await mongoose.disconnect();
        console.log("Disconnected from MongoDB");
    }
};

// Migrate the documents from Leads to Documents collection and replacing it with objectId
async function migrateDocuments() {
    try {
        // Step 1
        console.log("Starting document migration...");
        const leads = await Lead.find({
            isRejected: false,
            // $or: [
            //     { documents: { $exists: false } }, // Field doesn't exist
            //     { documents: null }, // Field exists but is null
            // ],
        });

        for (const lead of leads) {
            console.log(lead);
            const { pan, document: leadDocuments } = lead;

            // Skip leads without documents
            if (!leadDocuments) {
                console.log(`Skipping lead ${lead._id} - No documents.`);
                const existingDoc = await Documents.findOne({ pan: pan });
                if (existingDoc) {
                    lead.documents = existingDoc._id;
                    await lead.save();
                } else {
                    const docs = await Documents.create({ pan: pan });
                    lead.documents = docs._id;
                    await lead.save();
                }
                console.log(`Processed lead ${lead._id} with PAN ${pan}`);
            }

            let existingDoc = await Documents.findOne({ pan });

            if (!existingDoc) {
                // Create a new document record if none exists
                existingDoc = new Documents({
                    pan,
                    document: { singleDocuments: [], multipleDocuments: {} },
                });
            }

            // Merge singleDocuments
            const existingSingleDocs =
                existingDoc.document.singleDocuments || [];
            const newSingleDocs = leadDocuments.singleDocuments || [];

            newSingleDocs.forEach((newDoc) => {
                const existingIndex = existingSingleDocs.findIndex(
                    (doc) => doc.type === newDoc.type
                );
                if (existingIndex !== -1) {
                    // Update existing document of the same type
                    existingSingleDocs[existingIndex] = newDoc;
                } else {
                    // Add new document if type doesn't exist
                    existingSingleDocs.push(newDoc);
                }
            });

            existingDoc.document.singleDocuments = existingSingleDocs;

            // Merge multipleDocuments
            const existingMultipleDocs =
                existingDoc.document.multipleDocuments || {};
            const newMultipleDocs = leadDocuments.multipleDocuments || {};

            for (const [key, newDocs] of Object.entries(newMultipleDocs)) {
                if (!existingMultipleDocs[key]) {
                    existingMultipleDocs[key] = [];
                }
                if (newDocs === null || newDocs === undefined) {
                    continue;
                }
                existingMultipleDocs[key].push(...newDocs);
            }

            existingDoc.document.multipleDocuments = existingMultipleDocs;

            // Save the updated document
            await existingDoc.save();

            // Update the lead's document field to reference the new Document ObjectId
            lead.documents = existingDoc._id;
            // Remove the old document field (the object) from the lead
            // lead.document = undefined;
            await lead.save();

            console.log(`Processed lead ${lead._id} with PAN ${pan}`);
        }

        console.log("Document migration completed successfully!");
    } catch (error) {
        console.error("An error occurred during migration:", error);
    }
}

// Function to add Loan number to Sanction records
const updateLoanNumber = async () => {
    try {
        // Step 1: Copy existing loanNo from Disbursal to Sanction
        const disbursals = await Disbursal.find({ loanNo: { $exists: true } });
        console.log(`Found ${disbursals.length} disbursal records with loanNo`);

        for (const disbursal of disbursals) {
            await Sanction.updateOne(
                { _id: disbursal.sanction.toString() },
                { $set: { loanNo: disbursal.loanNo } }
            );
        }
        console.log("Copied loanNo from Disbursal to Sanction");

        const lastSanctioned = await mongoose.model("Sanction").aggregate([
            {
                $match: { loanNo: { $exists: true, $ne: null } },
            },
            {
                $project: {
                    numericLoanNo: {
                        $toInt: { $substr: ["$loanNo", 6, -1] }, // Extract numeric part
                    },
                },
            },
            {
                $sort: { numericLoanNo: -1 }, // Sort in descending order
            },
            { $limit: 1 }, // Get the highest number
        ]);

        // // Step 2: Find the next available loanNo
        // const allSanctions = await Sanction.find({
        //     loanNo: { $exists: true },
        // }).sort({ loanNo: 1 });
        // const existingLoanNumbers = allSanctions.map((sanction) =>
        //     parseInt(sanction.loanNo.slice(7))
        // );
        // console.log("Existing loan numbers:", existingLoanNumbers);
        // let nextLoanNo = 1;
        // while (existingLoanNumbers.includes(nextLoanNo)) {
        //     nextLoanNo++;
        // }

        const lastSequence =
            lastSanctioned.length > 0 ? lastSanctioned[0].numericLoanNo : 0;
        const newSequence = lastSequence + 1;

        const nextLoanNo = `NMFSPE${String(newSequence).padStart(11, 0)}`;

        // Step 3: Update loanNo for approved Sanction records without loanNo
        const sanctionsToUpdate = await Sanction.find({
            isApproved: true,
            loanNo: { $exists: false },
        });
        console.log(
            `Found ${sanctionsToUpdate.length} approved sanctions without loanNo`
        );

        for (const sanction of sanctionsToUpdate) {
            // Generate the next loanNo
            const nextLoanNo = `NMFSPE${String(newSequence).padStart(11, 0)}`;

            // Update the sanction with the new loanNo
            await Sanction.updateOne(
                { _id: sanction._id },
                { $set: { loanNo: nextLoanNo } }
            );

            // Increment the nextLoanNo and ensure no duplicates
            // nextLoanNo++;
            // while (existingLoanNumbers.includes(nextLoanNo)) {
            //     nextLoanNo++;
            // }
        }

        console.log("Updated loanNo for all approved sanctions without loanNo");
    } catch (error) {
        console.log(`Some error occured: ${error}`);
    }
};

// Function to migrate approved sanction applications to Closed collection under Active leads
const sanctionActiveLeadsMigration = async () => {
    try {
        const sanctions = await Sanction.find({
            isApproved: true,
            loanNo: { $exists: true },
        }).populate({
            path: "application",
            populate: { path: "lead" },
        });

        for (const sanction of sanctions) {
            // Find the corresponding disbursal record
            const disbursal = await Disbursal.findOne({
                loanNo: sanction.loanNo,
            });

            if (disbursal) {
                // Find an existing record in the Closed collection using the pan
                let existingActiveLead = await Closed.findOne({
                    pan: sanction.application.lead.pan,
                });

                // Data object to be added to the Closed collection
                const dataToAdd = {
                    disbursal: disbursal._id,
                    loanNo: sanction.loanNo,
                };

                // Add isDisbursed field if it is true in the disbursal record
                if (disbursal.isDisbursed) {
                    dataToAdd.isDisbursed = true;
                }

                if (existingActiveLead) {
                    // Check if the loanNo already exists in the data array
                    const existingDataIndex = existingActiveLead.data.findIndex(
                        (item) => item.loanNo === sanction.loanNo
                    );
                    if (existingDataIndex > -1) {
                        // Update the existing data object
                        existingActiveLead.data[existingDataIndex] = {
                            ...existingActiveLead.data[existingDataIndex],
                            ...dataToAdd, // Update with new data
                        };
                    } else {
                        // Add a new object to the data array
                        existingActiveLead.data.push(dataToAdd);
                    }
                    await existingActiveLead.save();
                } else {
                    // Create a new record in the Closed collection
                    const newActiveLead = await Closed.create({
                        pan: sanction.application.lead.pan,
                        data: [dataToAdd],
                    });

                    if (!newActiveLead) {
                        console.log(
                            "Some error occurred while creating an active lead."
                        );
                    }
                }
            } else {
                console.log(
                    `No Disbursal found for loanNo: ${sanction.loanNo}`
                );
            }
        }
    } catch (error) {
        console.log(`Some error occured: ${error}`);
    }
};

const sanctionDataChange = async () => {
    try {
        // Load the Excel file
        const workbook = xlsx.readFile("PAN_Matching_Results.xlsx"); // replace with your file path
        const sheetName = workbook.SheetNames[0]; // assuming data is in the first sheet
        const sheet = workbook.Sheets[sheetName];

        const range = xlsx.utils.decode_range(sheet["!ref"]);

        // Extract PAN numbers from column B, starting at row 2
        const sanctionIds = [];

        for (let row = 1; row <= range.e.r; row++) {
            // row 1 corresponds to D2
            const cellAddress = `C${row + 1}`;
            const cell = sheet[cellAddress];
            if (cell && cell.v) {
                const cleanedId = cell.v.replace(/\s+/g, "");
                // Check if the cell exists and has a value
                sanctionIds.push(cleanedId);
            }
        }

        let sanctions = [];
        let sanctioned = [];

        const lastSanctioned = await mongoose.model("Sanction").aggregate([
            {
                $match: { loanNo: { $exists: true, $ne: null } },
            },
            {
                $project: {
                    numericLoanNo: {
                        $toInt: { $substr: ["$loanNo", 6, -1] }, // Extract numeric part
                    },
                },
            },
            {
                $sort: { numericLoanNo: -1 }, // Sort in descending order
            },
            { $limit: 1 }, // Get the highest number
        ]);

        for (const id of sanctionIds) {
            // Check Id in sanction
            const sanction = await Sanction.findById(id).populate({
                path: "application",
                populate: { path: "lead" },
            });
            const application = await Application.findById(
                sanction.application._id.toString()
            );
            const cam = await CamDetails.findOne({
                leadId: sanction.application.lead._id.toString(),
            });

            sanction.isApproved = true;
            sanction.eSigned = true;
            sanction.isDibursed = true;
            sanction.approvedBy = "672089a263c1e1bd8a0ba8b7";
            sanction.recommendedBy = sanction.application.recommendedBy;
            sanction.sanctionDate = cam.disbursalDate;

            // const sanction = await Sanction.findByIdAndUpdate(id,{
            //     isApproved: true,

            // }).populate({ path: "recommendedBy", select: "fName mName lName" });

            // if (sanction) {
            //     const application = await Application.findOne({
            //         lead: lead._id,
            //     }).populate([
            //         { path: "lead" },
            //         { path: "recommendedBy", select: "fName mName lName" },
            //     ]);

            //     if (application) {
            //         const sanction = await Sanction.findOne({
            //             application: application._id,
            //         }).populate([
            //             { path: "application", populate: { path: "lead" } },
            //             { path: "recommendedBy", select: "fName mName lName" },
            //         ]);
            //         if (sanction?.isApproved) {
            //             sanctionedCount += 1;
            //             sanctioned.push(
            //                 // `${sanction.application.lead.fName}${
            //                 //     sanction.application.lead.mName &&
            //                 //     ` ${sanction.application.lead.mName}`
            //                 // }${
            //                 //     sanction.application.lead.lName &&
            //                 //     ` ${sanction.application.lead.lName}`
            //                 // }, ${sanction.application.lead.mobile}, ${
            //                 //     sanction.application.lead.pan
            //                 // }`
            //                 `${sanction._id.toString()}`
            //             );
            //         } else if (sanction) {
            //             sanctionCount += 1;
            //             sanctions.push(
            //                 // `${sanction.application.lead.fName}${
            //                 //     sanction.application.lead.mName &&
            //                 //     ` ${sanction.application.lead.mName}`
            //                 // }${
            //                 //     sanction.application.lead.lName &&
            //                 //     ` ${sanction.application.lead.lName}`
            //                 // }, ${sanction.application.lead.mobile}, ${
            //                 //     sanction.application.lead.pan
            //                 // }`
            //                 `${sanction._id.toString()}`
            //             );
            //         } else {
            //             applicationCount += 1;
            //             applications.push(
            //                 // `${application.lead.fName}${
            //                 //     application.lead.mName &&
            //                 //     ` ${application.lead.mName}`
            //                 // }${
            //                 //     application.lead.lName &&
            //                 //     ` ${application.lead.lName}`
            //                 // }, ${application.lead.mobile}, ${
            //                 //     application.lead.pan
            //                 // }`
            //                 `${application._id.toString()}`
            //             );
            //         }
            //     } else {
            //         leadCount += 1;
            //         leads.push(
            //             // `${lead.fName}${lead.mName && ` ${lead.mName}`}${
            //             //     lead.lName && ` ${lead.lName}`
            //             // }, ${lead.mobile}, ${lead.pan}`
            //             `${lead._id.toString()}`
            //         );
            //     }
            // } else {
            //     console.log(`No lead found for PAN ${panNumber}`);
            // }
        }
        // Prepare data for Excel with leads in column A, applications in column B, and sanctions in column C
        const maxLength = Math.max(
            leads.length,
            applications.length,
            sanctions.length
        );
        const data = [
            ["Lead", "Application", "Sanction", "Sanctioned"], // Header row
            ...Array.from({ length: maxLength }, (_, i) => [
                leads[i] || "", // Column A
                applications[i] || "", // Column B
                sanctions[i] || "", // Column C
                sanctioned[i] || "", // Column D
            ]),
        ];

        // Create a new workbook and worksheet
        const newWorkbook = xlsx.utils.book_new();
        const newWorksheet = xlsx.utils.aoa_to_sheet(data);

        // Append the worksheet to the workbook
        xlsx.utils.book_append_sheet(newWorkbook, newWorksheet, "PAN Results");

        // Write the workbook to a file
        xlsx.writeFile(newWorkbook, "PAN_Matching_Results.xlsx");

        console.log(
            "PAN matching process completed and results saved to Excel"
        );
    } catch (error) {
        console.error("Error during PAN matching:", error);
    } finally {
        // Disconnect from MongoDB
        await mongoose.disconnect();
        console.log("Disconnected from MongoDB");
    }
};

// Utility function to get the start and end of the current day
const getTodayRange = () => {
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);

    const endOfDay = new Date();
    endOfDay.setUTCHours(23, 59, 59, 999);

    return { startOfDay, endOfDay };
};

// Function to extract data and generate Excel
export const exportApprovedSanctions = async () => {
    try {
        const { startOfDay, endOfDay } = getTodayRange();

        // Query the database
        const sanctions = await Sanction.find({
            isApproved: true,
            updatedAt: { $gte: startOfDay, $lte: endOfDay },
        })
            .populate({
                path: "application",
                populate: [{ path: "applicant" }, { path: "lead" }],
            }) // Populate refs if needed
            .lean(); // Return plain JavaScript objects

        if (sanctions.length === 0) {
            console.log("No data found for today.");
            return;
        }

        // Format data for Excel
        const data = await Promise.all(
            sanctions.map(async (sanction) => {
                const cam = await CamDetails.findOne({
                    leadId: sanction.application.lead._id.toString(),
                });
                const bank = await Bank.findOne({
                    borrowerId: sanction.application.applicant,
                });
                return {
                    "Loan No": sanction.loanNo,

                    Name: `${sanction.application.lead.fName}${
                        sanction.application.lead.mName &&
                        ` ${sanction.application.lead.mName}`
                    }${
                        sanction.application.lead.lName &&
                        ` ${sanction.application.lead.lName}`
                    }`,
                    PAN: sanction.application.lead.pan,
                    "Sanctioned Amount": cam.details.loanRecommended,
                    "Disbursal Amount": cam.details.netDisbursalAmount,
                    // "Repayment Amount": cam.details.repaymentAmount,
                    PF: cam.details.netAdminFeeAmount,
                    "PF%": cam.details.adminFeePercentage,
                    ROI: cam.details.roi,
                    Tenure: cam.details.eligibleTenure,
                    "Disbursal Date": cam.details.disbursalDate,
                    "Repayment Date": cam.details.repaymentDate,
                    "Bank Name": bank.bankName,
                    accountNo: bank.bankAccNo,
                    IFSC: bank.ifscCode,
                    "Residence Address":
                        sanction.application.applicant.residence.address,
                    "Residence City":
                        sanction.application.applicant.residence.city,
                    "Residence State":
                        sanction.application.applicant.residence.state,
                    "Residence Pincode":
                        sanction.application.applicant.residence.pincode,
                };
            })
        );

        return data;
    } catch (error) {
        console.error("Error generating Excel file:", error);
    }
};

export const exportDisbursedData = async () => {
    try {
        const formatDate = (date) =>
            date
                ? moment(date).tz("Asia/Kolkata").format("DD MMM YYYY")
                : "N/A";

        // Fetch disbursed records with necessary fields
        const disbursals = await Disbursal.find(
            { isDisbursed: true },
            {
                loanNo: 1,
                amount: 1,
                pan: 1,
                utr: 1,
                payableAccount: 1,
                disbursedAt: 1,
                sanction: 1,
            }
        )
            .populate({
                path: "sanction",
                select: "application approvedBy",
                populate: [
                    {
                        path: "application",
                        select: "applicant lead recommendedBy",
                        populate: [
                            {
                                path: "lead",
                                select: "fName mName lName pan gender dob aadhaar mobile alternateMobile personalEmail officeEmail recommendedBy createdAt",
                                populate: {
                                    path: "recommendedBy",
                                    select: "fName mName lName",
                                },
                            },
                            {
                                path: "recommendedBy", // <-- Explicitly populating application.recommendedBy
                                select: "fName mName lName",
                            },
                            {
                                path: "applicant", // <-- Explicitly populating application.applicant
                                select: "residence employment",
                            },
                        ],
                    },
                    {
                        path: "approvedBy",
                        select: "fName mName lName",
                    },
                ],
            })
            .lean();

        // Extract necessary IDs for batch queries
        const leadIds = disbursals
            .map((d) => d.sanction?.application?.lead?._id)
            .filter(Boolean);
        const aadhaarNumbers = disbursals
            .map((d) => d.sanction?.application?.lead?.aadhaar)
            .filter(Boolean);
        const borrowerIds = disbursals
            .map((d) => d.sanction?.application?.applicant)
            .filter(Boolean);
        const loanNumbers = disbursals.map((d) => d.loanNo).filter(Boolean);

        // Fetch related data in parallel
        const [cams, aadhaars, banks, disbursedDates] = await Promise.all([
            CamDetails.find(
                { leadId: { $in: leadIds } },
                "leadId details.loanRecommended details.roi details.actualNetSalary details.eligibleTenure details.repaymentAmount details.netAdminFeeAmount details.adminFeePercentage details.repaymentDate"
            ).lean(),
            AadhaarDetails.find(
                { uniqueId: { $in: aadhaarNumbers } },
                "uniqueId details.address.state"
            ).lean(),
            Bank.find(
                { borrowerId: { $in: borrowerIds } },
                "borrowerId accountType bankName beneficiaryName bankAccNo ifscCode"
            ).lean(),
            Disbursal.find(
                { loanNo: { $in: loanNumbers }, isDisbursed: true },
                "loanNo disbursedAt pan"
            ).lean(),
        ]);

        // Create lookup maps for fast access
        const camMap = Object.fromEntries(
            cams.map((cam) => [cam.leadId.toString(), cam])
        );
        const aadhaarMap = Object.fromEntries(
            aadhaars.map((a) => [a.uniqueId, a])
        );
        const bankMap = Object.fromEntries(
            banks.map((b) => [b.borrowerId.toString(), b])
        );
        const disbursedMap = disbursedDates.reduce((acc, d) => {
            acc[d.pan] = acc[d.pan] || [];
            acc[d.pan].push(d);
            return acc;
        }, {});

        // Process and map data efficiently
        const disbursedData = disbursals
            .map((disbursed) => {
                const {
                    sanction,
                    loanNo,
                    amount,
                    pan,
                    utr,
                    payableAccount,
                    disbursedAt,
                } = disbursed;
                const application = sanction?.application;
                const lead = application?.lead;
                const applicant = application?.applicant;
                const approvedBy = sanction?.approvedBy;

                if (
                    !lead ||
                    [
                        "IUUPK1335L",
                        "AVZPC6217D",
                        "IJXPD6084F",
                        "HKCPK6182A",
                        "DVWPG0881D",
                        "EMOPA6923C",
                        "KBHPS9785J",
                    ].includes(lead.pan)
                ) {
                    return null;
                }

                const cam = camMap[lead._id?.toString()];
                const aadhaarDetails = aadhaarMap[lead.aadhaar];
                const bank = bankMap[applicant?._id?.toString()];

                // Determine loan status
                const loanDisbursalDates = (disbursedMap[pan] || []).sort(
                    (a, b) => new Date(a.disbursedAt) - new Date(b.disbursedAt)
                );
                const status =
                    loanDisbursalDates.findIndex(
                        (d) =>
                            d.disbursedAt.toISOString() ===
                            disbursedAt.toISOString()
                    ) === 0
                        ? "FRESH"
                        : `REPEAT-${loanDisbursalDates.findIndex(
                              (d) =>
                                  d.disbursedAt.toISOString() ===
                                  disbursedAt.toISOString()
                          )}`;

                // Prepare structured data
                return {
                    "Lead Created": formatDate(lead.createdAt),
                    "Disbursed Date": formatDate(disbursedAt),
                    "Repayment Date": formatDate(cam?.details?.repaymentDate),
                    "Loan No": loanNo || "",
                    Name: [lead.fName, lead.mName, lead.lName]
                        .filter(Boolean)
                        .join(" "),
                    Gender: `${
                        lead?.gender === "M"
                            ? "Male"
                            : lead?.gender === "F"
                            ? "Female"
                            : "Other"
                    }`,
                    DOB: formatDate(lead.dob),
                    Salary: cam?.details?.actualNetSalary,
                    "Account Type": bank?.accountType,
                    PAN: lead.pan || "",
                    Aadhaar: lead.aadhaar ? `'${String(lead.aadhaar)}` : "",
                    Mobile: lead.mobile,
                    "Alternate Mobile": lead.alternateMobile,
                    Email: lead.personalEmail,
                    "Office Email": lead.officeEmail,
                    "Sanctioned Amount": cam?.details?.loanRecommended || 0,
                    ROI: cam?.details?.roi,
                    Tenure: cam?.details?.eligibleTenure,
                    Status: status,
                    "Interest Amount": cam?.details?.repaymentAmount
                        ? cam.details.repaymentAmount -
                          cam.details.loanRecommended
                        : 0,
                    "Disbursed Amount": amount || 0,
                    "Repayment Amount": cam?.details?.repaymentAmount || 0,
                    PF: cam?.details?.netAdminFeeAmount || 0,
                    "PF%": cam?.details?.adminFeePercentage || 0,
                    "Beneficiary Bank Name": bank?.bankName || "",
                    "Beneficiary Name": bank?.beneficiaryName || "",
                    accountNo: bank?.bankAccNo || "",
                    IFSC: bank?.ifscCode || "",
                    "Disbursed Bank": payableAccount || "",
                    UTR: utr ? `${String(utr)}` : "",
                    Screener: formatFullName(
                        lead?.recommendedBy?.fName,
                        lead?.recommendedBy?.mName,
                        lead?.recommendedBy?.lName
                    ),
                    "Credit Manager": formatFullName(
                        application?.recommendedBy?.fName,
                        application?.recommendedBy?.mName,
                        application?.recommendedBy?.lName
                    ),
                    "Sanctioned By": formatFullName(
                        approvedBy?.fName,
                        approvedBy?.mName,
                        approvedBy?.lName
                    ),
                    "Residence Address": applicant?.residence?.address || "",
                    "Residence City": applicant?.residence?.city || "",
                    "Residence State":
                        aadhaarDetails?.details?.address?.state || "",
                    "Residence Pincode": applicant?.residence?.pincode || "",
                    "Company Name": applicant?.employment?.companyName || "",
                    "Company Address":
                        applicant?.employment?.companyAddress || "",
                    "Company State": applicant?.employment?.state || "",
                    "Company City": applicant?.employment?.city || "",
                    "Company Pincode": applicant?.employment?.pincode || "",
                };
            })
            .filter(Boolean);
        return disbursedData;
    } catch (error) {
        console.error("Error generating report:", error);
    }
};

// Function to send approved sanctions to disbursal
const sendApprovedSanctionToDisbursal = async () => {
    try {
        const ids = ["679b46561327e9f0080c4680"];

        for (const id of ids) {
            // const lastSanctioned = await mongoose.model("Sanction").aggregate([
            //     {
            //         $match: { loanNo: { $exists: true, $ne: null } },
            //     },
            //     {
            //         $project: {
            //             numericLoanNo: {
            //                 $toInt: { $substr: ["$loanNo", 6, -1] }, // Extract numeric part
            //             },
            //         },
            //     },
            //     {
            //         $sort: { numericLoanNo: -1 }, // Sort in descending order
            //     },
            //     { $limit: 1 }, // Get the highest number
            // ]);

            // const lastSequence =
            //     lastSanctioned.length > 0 ? lastSanctioned[0].numericLoanNo : 0;
            // const newSequence = lastSequence + 1;

            // const nextLoanNo = `NMFSPE${String(newSequence).padStart(11, 0)}`;
            // const sanctionDate = new Date(2025, 0, 15, 8, 54);
            // const disbursedlDate = new Date(2025, 0, 15, 9, 35);

            // const sanction = await Sanction.findByIdAndUpdate(
            //     { _id: id },
            //     {
            //         $set: {
            //             approvedBy: "677b68a4c2ee186c16e93b6b",
            //             loanNo: "QUALON0000249",
            //             sanctionDate: sanctionDate,
            //         },
            //     },
            //     { new: true }
            // ).populate({ path: "application", populate: { path: "lead" } });

            const sanction = await Sanction.findById({ _id: id });

            if (!sanction) {
                console.log("No sanction found!!");
            }

            // const active = await createActiveLead(
            //     sanction?.application?.lead?.pan,
            //     sanction.loanNo
            // );

            // if (!active) {
            //     console.log("Failed to create an active lead!!");
            // }

            const disbursal = await Disbursal.create({
                sanction: sanction._id,
                loanNo: sanction.loanNo,
                sanctionedBy: sanction.approvedBy,
                // isRecommended: true,
                // isDisbursed: true,
                // recommendedBy: "677cbdf92273331a42535fc1",
                // disbursalManagerId: "677cbdf92273331a42535fc1",
                // disbursedAt: disbursedlDate,
                // amount: "44200",
                // channel: "imps",
                // paymentMode: "offline",
                // payableAccount: "6345126849",
            });
            console.log(disbursal);

            if (!disbursal) {
                console.log("Saving failed!!");
            }
            // Update the active record to include disbursal details
            // const updatedActive = await Closed.findOne({
            //     pan: sanction?.application?.lead?.pan,
            //     "data.loanNo": sanction?.loanNo,
            // });

            // if (updatedActive) {
            //     updatedActive.data.forEach((item) => {
            //         if (item.loanNo === sanction?.loanNo) {
            //             item.disbursal = disbursal._id.toString(); // Update the disbursal ID in the matched data array
            //         }
            //     });

            //     await updatedActive.save();
            // }
        }
        console.log("Disbursal Saved successfully");
    } catch (error) {
        console.log(`Some error occured: ${error}`);
    }
};

// Function to turn Esign true
const esignedSanctions = async () => {
    try {
        const loanNums = [
            "QUALON0000280",
            "QUALON0000282",
            "QUALON0000283",
            "QUALON0000286",
            "QUALON0000287",
            "QUALON0000288",
            "QUALON0000290",
            "QUALON0000291",
            "QUALON0000292",
            "QUALON0000295",
            "QUALON0000300",
            "QUALON0000301",
            "QUALON0000306",
            "QUALON0000307",
            "QUALON0000308",
            "QUALON0000311",
            "QUALON0000312",
            "QUALON0000313",
            "QUALON0000314",
        ];
        // const sanctions = await Sanction.updateMany(
        //     { isApproved: true },
        //     { $set: { eSigned: true, eSignPending: false } }
        // );
        // const disbursal = await Disbursal.find({ eSigned: true });
        // console.log(disbursal);

        const result = await Disbursal.updateMany(
            { loanNo: { $in: loanNums } }, // Match condition
            { $set: { sanctionESigned: true } } // Update operation
        );

        console.log(`Updated ${result.modifiedCount} documents.`);
        // const disbursal = await Disbursal.updateMany(
        //     {}, // Optional: select documents where eSigned is true
        //     { $set: { sanctionESigned: true }, $unset: { eSigned: "" } } // Remove the eSigned field
        // );
    } catch (error) {
        console.log(error.message);
    }
};

// Add Lead No to all leads
const addLeadNo = async () => {
    const leads = await Lead.find({}, { _id: 1 });
    const bulkOps = await Promise.all(
        leads.map(async (lead) => {
            const newLeadNo = await nextSequence("leadNo", "LD", 7);

            return {
                updateOne: {
                    filter: { _id: lead._id },
                    update: { $set: { leadNo: newLeadNo } },
                },
            };
        })
    );

    if (bulkOps.length) {
        await Lead.bulkWrite(bulkOps);
        console.log("Lead numbers added!!");
    } else {
        console.log("No leads found.");
    }
};

// const send LeadNo and Pan to application, sanction, disbursal
const sendLeadNoAndPan = async () => {
    try {
        // Step 1: Find all approved leads
        const leads = await Lead.find(
            { isRecommended: true },
            { _id: 1, leadNo: 1, pan: 1 }
        );

        if (!leads.length) {
            console.log("No approved leads found.");
            return;
        }

        // Step 2: Process each lead
        for (const lead of leads) {
            const { _id, leadNo, pan } = lead;

            // Update Application collection using leadId
            const applicationDocs = await Application.find(
                { lead: _id },
                { _id: 1 } // Fetch only the application IDs
            );

            if (applicationDocs.length) {
                // Add bulk operations for `Application`
                const applicationBulkOps = applicationDocs.map(
                    (application) => ({
                        updateOne: {
                            filter: { _id: application._id }, // Match by lead in Application
                            update: { $set: { leadNo, pan } }, // Add leadNo and pan
                        },
                    })
                );

                await Application.bulkWrite(applicationBulkOps);
                console.log(`Applications updated for lead ${leadNo}.`);
            }

            // Step 3: Update Sanction collection using application _id
            const applicationIds = applicationDocs.map((app) => app._id);
            const sanctionDocs = await Sanction.find(
                { application: { $in: applicationIds } },
                { _id: 1 } // Fetch only the sanction IDs
            );

            if (sanctionDocs.length) {
                // Create bulk operations for sanctions
                const sanctionBulkOps = sanctionDocs.map((sanction) => ({
                    updateOne: {
                        filter: { _id: sanction._id },
                        update: { $set: { leadNo, pan } },
                    },
                }));

                await Sanction.bulkWrite(sanctionBulkOps);
                console.log(`Sanctions updated for lead ${leadNo}.`);
            }

            // Step 4: Update Disbursal collection using sanction _id
            const sanctionIds = sanctionDocs.map((sanction) => sanction._id);
            const disbursalDocs = await Disbursal.find(
                { sanction: { $in: sanctionIds } },
                { _id: 1 } // Fetch only the Disbursal IDs
            );

            if (disbursalDocs.length) {
                // Create bulk operations for Disbursal
                const disbursalBulkOps = disbursalDocs.map((disbursal) => ({
                    updateOne: {
                        filter: { _id: disbursal._id },
                        update: { $set: { leadNo, pan } },
                    },
                }));

                await Disbursal.bulkWrite(disbursalBulkOps);
                console.log(`Disbursals updated for lead ${leadNo}.`);
            }
        }
    } catch (error) {
        console.log("error", error);
    }
};

const sendLeadInClosed = async () => {
    try {
        const disbursalIds = await Disbursal.find({}, { _id: 1, leadNo: 1 });
        const closedDocs = await Closed.find(
            { "data.disbursal": { $in: disbursalIds } }, // Match disbursal IDs within the "data" array
            { _id: 1, data: 1 } // Fetch only the Closed document IDs and data field
        );

        if (closedDocs.length) {
            const bulkOps = [];

            closedDocs.forEach((closedDoc) => {
                if (!Array.isArray(closedDoc.data)) {
                    console.log("No valid data found in closedDoc:", closedDoc);
                    return;
                }

                closedDoc.data.forEach((data) => {
                    const matchedDisbursal = disbursalIds.find(
                        (disbursal) =>
                            data.disbursal &&
                            data.disbursal.toString() ===
                                disbursal._id.toString()
                    );
                    if (matchedDisbursal) {
                        data.leadNo = matchedDisbursal.leadNo;
                    }
                });

                // Push to bulk operations
                bulkOps.push({
                    updateOne: {
                        filter: { _id: closedDoc._id },
                        update: { $set: { data: closedDoc.data } },
                    },
                });
            });

            if (bulkOps.length) {
                await Closed.bulkWrite(bulkOps);
                console.log("All closedDocs updated successfully in bulk.");
            } else {
                console.log("No updates needed for closedDocs.");
            }
        } else {
            console.log("No closedDocs matched the criteria.");
        }
    } catch (error) {
        console.log("error", error);
    }
};

// Update Loan Number in sanction, disbursal and closed
const updateLoanNo = async () => {
    try {
        // Fetch only approved sanctions that need a loan number
        const sanctions = await Sanction.find({ isApproved: true });

        for (const sanction of sanctions) {
            // Generate a new loan number
            // const loanNo = await nextSequence("loanNo", "LN", 7);

            // Update the sanction with the generated loan number
            // await Sanction.updateOne(
            //     { _id: sanction._id },
            //     { $set: { loanNo: loanNo } }
            // );

            // Update the corresponding disbursal record (if exists)
            await Disbursal.updateOne(
                { sanction: sanction._id },
                { $set: { loanNo: sanction.loanNo } }
            );

            // Update the corresponding closed record (if exists)
            await Closed.updateOne(
                { "data.leadNo": sanction.leadNo }, // Match the old loanNo
                { $set: { "data.$.loanNo": sanction.loanNo } } // Update with the new loanNo
            );
        }

        console.log("Loan numbers updated successfully");
    } catch (error) {
        console.log(`Some error occured: ${error}`);
    }
};

// Add leadNo in CAM
const addLeadNoInCam = async () => {
    try {
        const cams = await CamDetails.find({});
        for (const cam of cams) {
            const lead = await Lead.findById(cam.leadId);
            if (lead) {
                cam.leadNo = lead.leadNo;
                await cam.save();
            }
        }
        console.log("Lead numbers added to CAM");
    } catch (error) {
        console.log(`Some error occured: ${error}`);
    }
};

// Create Lead Status
const createLeadStatus = async () => {
    try {
        const leads = await Lead.find(
            {},
            {
                _id: 1,
                leadNo: 1,
                pan: 1,
                isRejected: 1,
                isRecommended: 1,
                onHold: 1,
            }
        );
        for (const lead of leads) {
            if (lead.isRejected) {
                await LeadStatus.create({
                    leadNo: lead.leadNo,
                    pan: lead.pan,
                    stage: "Lead",
                    isRejected: true,
                    isInProcess: false,
                });
            } else if (lead.onHold) {
                await LeadStatus.create({
                    leadNo: lead.leadNo,
                    pan: lead.pan,
                    stage: "Lead",
                    isHold: true,
                });
            } else {
                await LeadStatus.create({
                    leadNo: lead.leadNo,
                    pan: lead.pan,
                    stage: "Lead",
                });
            }
        }
        console.log("Lead status updated successfully");
    } catch (error) {
        console.log(`Some error occured: ${error}`);
    }
};

// Update Lead status
const updateLeadStatus = async () => {
    try {
        // Fetch all lead statuses
        const leadStatuses = await LeadStatus.find(
            {},
            {
                leadNo: 1,
                stage: 1,
                isInProcess: 1,
                isRejected: 1,
                isApproved: 1,
                isHold: 1,
            }
        );

        // Initialize bulk operations
        const bulkOps = [];

        for (const leadStatus of leadStatuses) {
            // Check if leadNo exists in Application, Sanction, and Disbursal collections
            const application = await Application.findOne({
                leadNo: leadStatus.leadNo,
            });
            const sanction = await Sanction.findOne({
                leadNo: leadStatus.leadNo,
            });
            const disbursal = await Disbursal.findOne({
                leadNo: leadStatus.leadNo,
            });

            // If the leadNo is not in any of the three collections, skip the update
            if (!application && !sanction && !disbursal) {
                continue; // Skip this lead
            }

            // Determine the last stage and rejection status
            let lastStage = null;
            let isRejected = false;
            // let isApproved = false;

            if (application) {
                lastStage = "Application";
                isRejected = application.isRejected || false;
            }
            if (sanction) {
                lastStage = "Sanction";
                isRejected = sanction.isRejected || false;
                // isApproved = sanction.isApproved || false;
            }
            if (disbursal) {
                lastStage = "Disbursal";
                isRejected = disbursal.isRejected || false;
                // isApproved = disbursal.isRejected ? false : true;
            }

            // Prepare the update object
            const updateFields = {
                stage: lastStage || leadStatus.stage,
                isInProcess: !isRejected,
                isRejected,
            };

            // If sanction exists and isApproved is true, update isApproved in LeadStatus
            if (sanction && sanction.isApproved) {
                updateFields.isApproved = true;
            }

            // If disbursal exists and isRejected is true, update isApproved in LeadStatus
            if (disbursal && disbursal.isRejected) {
                updateFields.isApproved = false;
            }

            // Push update operation
            bulkOps.push({
                updateOne: {
                    filter: { leadNo: leadStatus.leadNo },
                    update: { $set: updateFields },
                },
            });
        }

        // Execute bulkWrite if there are updates
        if (bulkOps.length > 0) {
            const result = await LeadStatus.bulkWrite(bulkOps);
            console.log(
                `Successfully updated ${result.modifiedCount} lead statuses.`
            );
        } else {
            console.log("No updates needed for lead statuses.");
        }
    } catch (error) {
        console.log(`Some error occured: ${error}`);
    }
};

// Update the eSigned true in sanctioned records
const updateEsign = async () => {
    try {
        // Find all disbursals with a disbursalManagerId
        const disbursals = await Disbursal.find(
            { disbursalManagerId: { $exists: true } },
            { sanction: 1 } // Only fetch the sanction field
        );

        // Extract unique sanction IDs
        const sanctionIds = disbursals.map((d) => d.sanction).filter(Boolean);

        if (sanctionIds.length === 0) {
            console.log("No sanctions found to update.");
            return;
        }

        // Update all matching sanctions in bulk
        const result = await Sanction.updateMany(
            { _id: { $in: sanctionIds } },
            { $set: { eSigned: true } }
        );

        console.log(`${result.modifiedCount} sanctions updated.`);
    } catch (error) {
        console.log("Error updating eSigned:", error.message);
    }
};

// Function to extract and group loan numbers by PAN from Excel
const extractLoanPanFromExcel = () => {
    const workbook = xlsx.readFile("Salarysaathi.xlsx");
    const sheet = workbook.Sheets[workbook.SheetNames[0]]; // Read first sheet

    const loanPanMap = new Map(); // Store PAN as key and Loan Numbers as an array

    let row = 2; // Start from row 2

    while (true) {
        const loanCell = sheet[`A${row}`];
        const panCell = sheet[`D${row}`];

        if (!loanCell || !panCell) break; // Stop when empty row is encountered

        const loanNo = loanCell.v.toString().trim();
        const pan = panCell.v.toString().trim();

        if (!loanPanMap.has(pan)) {
            loanPanMap.set(pan, []); // Initialize array if PAN not present
        }
        loanPanMap.get(pan).push(loanNo); // Append Loan No to PAN

        row++;
    }

    // Convert Map to an array of objects
    return Array.from(loanPanMap, ([pan, loanNos]) => ({ pan, loanNos }));
};

// Function to search Sanction collection with extracted PANs
const searchSanctionsByPAN = async () => {
    const loanPanArray = extractLoanPanFromExcel();
    // console.log("Extracted PANs and Loan Numbers:", loanPanArray);

    // Create a Map for quick lookup of loan numbers by PAN
    const panLoanMap = new Map(
        loanPanArray.map(({ pan, loanNos }) => [pan, loanNos])
    );
    const panArray = loanPanArray.map((item) => item.pan); // Extract PANs from array
    // console.log("PANs extracted from Excel:", panLoanMap);

    // Convert Map to JSON-friendly object
    const panLoanObject = Object.fromEntries(panLoanMap);

    // Save to a file
    // fs.writeFileSync("panLoanMap.json", JSON.stringify(panLoanObject, null, 2));

    // Fetch sanctions for the extracted PANs, sorted by sanctionDate (oldest first)
    const matchingSanctions = await Sanction.find(
        { pan: { $in: panArray }, sanctionDate: { $exists: true, $ne: null } },
        { _id: 1, pan: 1, leadNo: 1, sanctionDate: 1 }
    ).sort({ sanctionDate: 1 }); // Sort in ascending order

    // Group sanctions by PAN
    const panSanctionMap = new Map();

    for (const sanction of matchingSanctions) {
        const { pan, _id, sanctionDate } = sanction;

        if (!panSanctionMap.has(pan)) {
            panSanctionMap.set(pan, []); // Initialize array if PAN not present
        }
        panSanctionMap.get(pan).push({ sanctionId: _id, sanctionDate });
    }

    // Map loan numbers to the corresponding sanctions (oldest gets first loan)
    const panArrayWithSanctionsAndLoans = Array.from(
        panSanctionMap,
        ([pan, sanctions]) => {
            const loanNumbers = panLoanMap.get(pan) || []; // Get loan numbers for this PAN

            return {
                pan,
                sanctions: sanctions.map((sanction, index) => ({
                    ...sanction,
                    loanNo: loanNumbers[index] || null, // Assign loan numbers in order
                })),
            };
        }
    );

    // Save the array directly as JSON
    // fs.writeFileSync(
    //     "panMap.json",
    //     JSON.stringify(panArrayWithSanctionsAndLoans, null, 2)
    // );

    // **Updating Sanction Collection**
    for (const { sanctions } of panArrayWithSanctionsAndLoans) {
        for (const { sanctionId, loanNo } of sanctions) {
            if (loanNo) {
                await Sanction.updateOne(
                    { _id: sanctionId }, // Find by ID
                    { $set: { loanNo } } // Update loan number
                );
                console.log(
                    `Updated Sanction ID: ${sanctionId} with Loan No: ${loanNo}`
                );
            }
        }
    }

    console.log("Sanction collection updated successfully.");
};

// Update Loan Number in from LN to NMFSPE
const updateLoanNumberType = async () => {
    const sanctions = await Sanction.find({ loanNo: { $regex: /^LN/ } });
    // console.log(sanctions.length);

    for (const sanction of sanctions) {
        const newLoanNo = await nextSequence("loanNo", "NMFSPE", 11);
        await Sanction.updateOne(
            { _id: sanction._id },
            { $set: { loanNo: newLoanNo } }
        );
        console.log(
            `Updated Sanction ID: ${sanction._id} with Loan No: ${newLoanNo}`
        );
    }

    // console.log("Sanction collection updated successfully.");
};

// Add lead status reference
const addLeadStatusRef = async () => {
    try {
        const leadStatus = await LeadStatus.find({}, { leadNo: 1 });
        const bulkOps = leadStatus.map((status) => ({
            updateOne: {
                filter: { leadNo: status.leadNo },
                update: { $set: { leadStatus: status._id } },
            },
        }));
        await Lead.bulkWrite(bulkOps);
        console.log("Lead status reference added successfully");
    } catch (error) {
        console.log(`Some error occured: ${error}`);
    }
};

const moveSanctionLetterFiles = async (panNumber) => {
    try {
        const sourceFolder = `${panNumber}/`; // PAN-based folder
        const targetFolder = `${panNumber}/sanctionLetter/`;

        // List all objects in the PAN folder
        const { Contents } = await s3
            .listObjectsV2({ Bucket: BUCKET_NAME, Prefix: sourceFolder })
            .promise();

        if (!Contents || Contents.length === 0) {
            console.log(`No files found in ${sourceFolder}`);
            return;
        }

        // Filter files that start with "sanctionLetter-"
        const sanctionLetterFiles = Contents.filter((file) =>
            file.Key.includes("sanctionLetter-")
        );

        if (sanctionLetterFiles.length === 0) {
            console.log(`No sanctionLetter-* files found in ${sourceFolder}`);
            return;
        }

        // Move each file to the "sanctionLetter" folder
        for (let file of sanctionLetterFiles) {
            const newKey = file.Key.replace(sourceFolder, targetFolder);

            await s3
                .copyObject({
                    Bucket: BUCKET_NAME,
                    CopySource: `${BUCKET_NAME}/${file.Key}`,
                    Key: newKey,
                })
                .promise();

            // await s3
            //     .deleteObject({
            //         Bucket: BUCKET_NAME,
            //         Key: file.Key,
            //     })
            //     .promise();

            console.log(`Moved ${file.Key} to ${newKey}`);
        }

        console.log(
            `All sanctionLetter files moved successfully for PAN: ${panNumber}`
        );
    } catch (error) {
        console.error(
            `Error moving sanctionLetter files for PAN: ${panNumber}`,
            error
        );
    }
};

let count = 0;
const checkAndDeleteNestedSanctionLetter = async (panFolder) => {
    try {
        const sourceFolder = `${panFolder}/`;
        // console.log(sourceFolder);

        // List all objects in the sanctionLetter folder
        const { Contents } = await s3
            .listObjectsV2({
                Bucket: BUCKET_NAME,
                Prefix: sourceFolder,
            })
            .promise();

        if (!Contents || Contents.length === 0) {
            console.log(`No files found in ${sourceFolder}`);
            return;
        }

        // Check if there is a nested "sanctionLetter/" folder
        const nestedSanctionLetterFiles = Contents.filter((file) =>
            file.Key.startsWith(`${sourceFolder}sanctionLetter/sanctionLetter/`)
        );

        if (nestedSanctionLetterFiles.length === 0) {
            console.log(
                `No Nested sanctionLetter folder found in ${panFolder}.`
            );
            return;
        }
        console.log(
            `Nested sanctionLetter folder found in ${panFolder}. Deleting files...`
        );

        // Delete all files inside the nested sanctionLetter folder
        for (let file of nestedSanctionLetterFiles) {
            await s3
                .deleteObject({
                    Bucket: BUCKET_NAME,
                    Key: file.Key,
                })
                .promise();
            console.log(`Deleted: ${file.Key}`);
        }

        // console.log(`Nested sanctionLetter folder deleted successfully.`);
    } catch (error) {
        console.error("Error:", error);
    }
};

// update sanctionLetter from single to multiple
const updateSanctionLetters = async () => {
    try {
        // Find all documents where singleDocuments contains sanctionLetter
        const documents = await Documents.find({});

        console.log(`Found ${documents.length} documents to update.`);

        for (let doc of documents) {
            // const pan = doc.pan;
            // Filter out only sanctionLetter entries from singleDocuments
            // const sanctionLetters =
            //     doc.document.multipleDocuments.sanctionLetter;

            let updated = false;
            doc.document.multipleDocuments.sanctionLetter =
                doc.document.multipleDocuments.sanctionLetter.map((doc) => {
                    const regex = /^([^/]+)\/sanctionLetter-/; // Match {pan}/sanctionLetter-

                    if (regex.test(doc.url)) {
                        const updatedUrl = doc.url.replace(
                            regex,
                            `$1/sanctionLetter/sanctionLetter-`
                        );
                        console.log(`Updating: ${doc.url} -> ${updatedUrl}`); // Debugging
                        updated = true; // Mark that we made a change
                        return { ...doc, url: updatedUrl };
                    }
                    return doc;
                });

            // Save only if there was an update
            if (updated) {
                await doc.save();
                console.log("Document updated successfully.");
            } else {
                console.log("No updates were made.");
            }

            // const nestedSanctionLetterUrls = sanctionLetters
            //     .map((doc) => doc.url) // Extract URLs
            //     .filter((url) => url.startsWith(`${pan}/sanctionLetter-`));

            // await checkAndDeleteNestedSanctionLetter(pan);
            // if (sanctionLetters.length > 0) {
            //     // const sourceFolder = `${pan}/`; // PAN-based folder
            //     // const targetFolder = `${pan}/sanctionLetter/`;

            //     // List all objects in the PAN folder
            //     // const { Contents } = await s3
            //     //     .listObjectsV2({
            //     //         Bucket: BUCKET_NAME,
            //     //         Prefix: sourceFolder,
            //     //     })
            //     //     .promise();

            //     // if (!Contents || Contents.length === 0) {
            //     //     console.log(`No files found in ${sourceFolder}`);
            //     //     return;
            //     // }

            //     // Filter files that start with "sanctionLetter-"
            //     // const sanctionLetterFiles = Contents.filter((file) =>
            //     //     file.Key.includes("sanctionLetter-")
            //     // );

            //     // if (sanctionLetterFiles.length === 0) {
            //     //     console.log(
            //     //         `No sanctionLetter-* files found in ${sourceFolder}`
            //     //     );
            //     //     return;
            //     // }

            //     // Move each file to the "sanctionLetter" folder
            //     // let newKey;
            //     // for (let file of sanctionLetterFiles) {
            //     //     newKey = file.Key.replace(sourceFolder, targetFolder);

            //     //     await s3
            //     //         .copyObject({
            //     //             Bucket: BUCKET_NAME,
            //     //             CopySource: `${BUCKET_NAME}/${file.Key}`,
            //     //             Key: newKey,
            //     //         })
            //     //         .promise();

            //     //     // await s3
            //     //     //     .deleteObject({
            //     //     //         Bucket: BUCKET_NAME,
            //     //     //         Key: file.Key,
            //     //     //     })
            //     //     //     .promise();
            //     // }

            //     // Transform to multipleDocuments format
            //     const newSanctionLetters = sanctionLetters.map((item) => ({
            //         _id: new mongoose.Types.ObjectId(),
            //         name: item.name,
            //         url: item.url,
            //         remarks: item.remarks || "", // Default empty string if missing
            //     }));

            //     // Ensure multipleDocuments.sanctionLetter exists
            //     if (!doc.document.multipleDocuments.sanctionLetter) {
            //         doc.document.multipleDocuments.sanctionLetter = [];
            //     }

            //     // Append transformed sanctionLetters to multipleDocuments
            //     doc.document.multipleDocuments.sanctionLetter.push(
            //         ...newSanctionLetters
            //     );

            //     // Remove sanctionLetter from singleDocuments
            //     doc.document.singleDocuments =
            //         doc.document.singleDocuments.filter(
            //             (item) => item.name !== "sanctionLetter"
            //         );

            //     // Save the updated document
            //     await doc.save();

            //     console.log(`Updated document PAN: ${doc.pan}`);
            // }
        }

        console.log("Migration completed successfully! ✅");
        process.exit(0);
    } catch (error) {
        console.error("Error during migration:", error);
        process.exit(1);
    }
};

export const removeDuplicateCam = async () => {
    try {
        const duplicateCams = await CamDetails.aggregate([
            {
                $group: {
                    _id: "$leadNo",
                    count: { $sum: 1 },
                    ids: { $push: "$_id" }, // Collect all document IDs for this leadNo
                },
            },
            {
                $match: {
                    count: { $gt: 1 }, // Only leadNos with more than 1 entry
                },
            },
        ]);

        for (const cam of duplicateCams) {
            // console.log("lead Id: ", lead.ids);

            const toDelete = await CamDetails.find({
                _id: { $in: cam.ids }, // Select only the duplicate records
                $or: [
                    { "details.loanRecommended": { $exists: false } },
                    { "details.actualNetSalary": { $exists: false } },
                ],
            });

            if (toDelete.length > 0) {
                await CamDetails.deleteMany({
                    _id: { $in: toDelete.map((doc) => doc._id) },
                });
                console.log(`Deleted ${toDelete.length} duplicate CAM details`);
            }
        }
    } catch (error) {
        console.log(error.message);
        exit;
    }
};

// Main Function to Connect and Run
async function main() {
    // await connectToDatabase(); // Start - Connect to the database
    // await migrateDocuments();
    // await updateLoanNumber();
    // await sanctionActiveLeadsMigration();
    // await updateLeadsWithDocumentIds();
    // await matchPANFromExcel();
    // await exportApprovedSanctions();
    // addRecommendedByToSanctions();
    // await sendApprovedSanctionToDisbursal();
    // await esignedSanctions();
    // await addLeadNo(); // Step - 1
    // await sendLeadNoAndPan(); // Step - 2
    // await sendLeadInClosed(); // Step - 3
    // await addLeadNoInCam(); // Step - 4
    // await updateLoanNo(); // Step - 5
    // await createLeadStatus(); // Step - 6
    // await updateLeadStatus(); // Step - 7
    // await updateEsign();
    // await searchSanctionsByPAN();
    // await updateLoanNumberType();
    // await addLeadStatusRef();
    // await updateSanctionLetters();
    // await removeDuplicateCam();
    // updateDisbursals();
    // migrateApplicationsToSanctions();
    mongoose.connection.close(); // Close the connection after the script completes
}

main().catch((error) => {
    console.error("Error during migration:", error);
    mongoose.connection.close(); // Ensure connection is closed in case of errors
});
