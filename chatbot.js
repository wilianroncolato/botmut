// Importação das bibliotecas necessárias
const qrcode = require('qrcode-terminal');
const { Client } = require('whatsapp-web.js');
const fs = require('fs');
const Airtable = require('airtable');

// --- CONFIGURAÇÃO DAS SUAS CHAVES ---
const AIRTABLE_TOKEN = 'patDlqy5XfT0AXzIv.bb3f0761b2a63895d519605992e021c6cd3f8517691b77f6ec83be1f4c444708';
const AIRTABLE_BASE_ID = 'appEkEYdgrUBJj3YR';

// --- NOMES DAS TABELAS E COLUNAS ---
const AIRTABLE_ORDERS_TABLE_NAME = 'Pedidos';
const AIRTABLE_ORDER_ID_COLUMN = 'ID_Pedido';
const AIRTABLE_STATUS_COLUMN = 'Status';
const AIRTABLE_DELIVERY_COLUMN = 'DataEntregaPrevista';
const AIRTABLE_LINK_TO_ITEMS_COLUMN = 'Itens_Pedido';

const AIRTABLE_LINE_ITEMS_TABLE_NAME = 'Itens_Pedido';
const AIRTABLE_LINK_TO_KIT_COLUMN = 'Kit';

const AIRTABLE_KITS_TABLE_NAME = 'Kits';
const AIRTABLE_KIT_NAME_COLUMN = 'Nome do Kit';


// Configuração da conexão com o Airtable
Airtable.configure({ apiKey: AIRTABLE_TOKEN });
const base = Airtable.base(AIRTABLE_BASE_ID);

// Criação do cliente do WhatsApp
const client = new Client();

client.on('qr', qr => {
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('Tudo certo! WhatsApp conectado e pronto para operar. ✨');
});

client.initialize();

// --- FUNÇÕES E VARIÁVEIS AUXILIARES ---
const delay = ms => new Promise(res => setTimeout(res, ms));
const userState = {};
const PAUSE_TIMEOUT = 45 * 60 * 1000;
const DB_FILE = './db.json';

function readDatabase() {
    try {
        if (fs.existsSync(DB_FILE)) {
            const data = fs.readFileSync(DB_FILE);
            return data.length > 0 ? JSON.parse(data) : {};
        }
        return {};
    } catch (error) {
        console.log("Erro ao ler o banco de dados:", error);
        return {};
    }
}

function saveUserData(userId, userData) {
    const db = readDatabase();
    db[userId] = { ...db[userId], ...userData };
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function formatName(text) {
    const name = text.trim();
    if (!name) return null;
    return name.split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

function calculateTypingDelay(message) {
    const msPerChar = 40;
    let calculatedDelay = message.length * msPerChar;
    const minDelay = 1200;
    const maxDelay = 5000;
    return Math.max(minDelay, Math.min(calculatedDelay, maxDelay));
}

function isWithinBusinessHours() {
    const now = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
    const day = now.getDay();
    const hour = now.getHours();
    const minute = now.getMinutes();
    const currentTime = hour + (minute / 60);

    if (day === 0) return false;
    if (day === 6) return currentTime >= 9.5 && currentTime < 12;
    if (day === 5) return currentTime >= 9.5 && currentTime < 16.5;
    if (day >= 1 && day <= 4) return currentTime >= 9.5 && currentTime < 17;

    return false;
}

function formatAirtableDate(isoDate) {
    if (!isoDate) return 'Não informada';
    try {
        const date = new Date(isoDate);
        const userTimezoneOffset = date.getTimezoneOffset() * 60000;
        const correctedDate = new Date(date.getTime() + userTimezoneOffset);
        const day = String(correctedDate.getDate()).padStart(2, '0');
        const month = String(correctedDate.getMonth() + 1).padStart(2, '0');
        const year = correctedDate.getFullYear();
        return `${day}/${month}/${year}`;
    } catch (error) { return 'Data inválida'; }
}

async function findOrderInAirtable(orderIdToFind) {
    console.log(`Buscando Pedido no Airtable: ${orderIdToFind}`);
    const formula = `({${AIRTABLE_ORDER_ID_COLUMN}} = ${orderIdToFind})`;

    try {
        const orderRecords = await base(AIRTABLE_ORDERS_TABLE_NAME).select({ maxRecords: 1, filterByFormula: formula }).firstPage();
        if (orderRecords.length === 0) return null;
        const orderData = orderRecords[0].fields;

        const lineItemRecordIds = orderData[AIRTABLE_LINK_TO_ITEMS_COLUMN];
        let itemNames = 'Não informado';

        if (lineItemRecordIds && lineItemRecordIds.length > 0) {
            const lineItemRecords = await Promise.all(lineItemRecordIds.map(id => base(AIRTABLE_LINE_ITEMS_TABLE_NAME).find(id)));
            const finalKitRecordIds = lineItemRecords.flatMap(record => record.get(AIRTABLE_LINK_TO_KIT_COLUMN) || []);
            if (finalKitRecordIds.length > 0) {
                const finalKitRecords = await Promise.all(finalKitRecordIds.map(id => base(AIRTABLE_KITS_TABLE_NAME).find(id)));
                itemNames = finalKitRecords.map(record => record.get(AIRTABLE_KIT_NAME_COLUMN)).join(', ');
            }
        }
        
        return {
            status: orderData[AIRTABLE_STATUS_COLUMN],
            deliveryDate: formatAirtableDate(orderData[AIRTABLE_DELIVERY_COLUMN]),
            items: itemNames
        };

    } catch (error) {
        console.error("ERRO AO BUSCAR DADOS NO AIRTABLE:", error);
        return null;
    }
}

// Vigia que reativa o bot por inatividade
setInterval(() => {
    const now = Date.now();
    const db = readDatabase();
    for (const user in userState) {
        const state = userState[user];
        if (!state || !state.timestamp) continue;
        const timeElapsed = now - state.timestamp;

        if (state.stage === 'paused' && timeElapsed > PAUSE_TIMEOUT) {
            console.log(`--> Bot reativado automaticamente por inatividade para: ${user}`);
            delete userState[user];
        }
        else if (state.stage === 'interest_shown' && timeElapsed > (24 * 60 * 60 * 1000)) {
            const userName = db[user]?.name?.split(' ')[0] || '';
            const followupMessage = `Olá, ${userName}! Passando para saber se ficou alguma dúvida sobre o MUTSLIM que eu possa te ajudar a esclarecer. Estamos à disposição! 😊`;
            client.sendMessage(user, followupMessage);
            delete userState[user];
        }
        else if (state.stage === 'pending_survey' && timeElapsed > (60 * 60 * 1000)) {
            const userName = db[user]?.name?.split(' ')[0] || 'cliente';
            const surveyMessage = `Olá, ${userName}! Esperamos que suas dúvidas tenham sido resolvidas. Para nos ajudar a melhorar sempre, como você avalia o atendimento que recebeu, numa nota de 0 a 10?`;
            client.sendMessage(user, surveyMessage);
            userState[user] = { stage: 'awaiting_survey_response' };
        }
    }
}, 60 * 1000);

// "O ESPIÃO": Ouve as SUAS mensagens para pausar/reativar o bot
client.on('message_create', async (msg) => {
    if (msg.fromMe) {
        const customerId = msg.to;
        const messageBody = msg.body.toLowerCase();
        const normalizedMessage = messageBody.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

        if (messageBody === 'qualquer coisa ficamos a disposição 😉') {
            if (userState[customerId] && userState[customerId].stage === 'paused') {
                userState[customerId] = { stage: 'pending_survey', timestamp: Date.now() };
                console.log(`--> Bot REATIVADO (frase gatilho). Pesquisa de satisfação agendada para: ${customerId}.`);
            }
        }
        else if (normalizedMessage.includes('flavia')) {
            if (!userState[customerId] || userState[customerId].stage !== 'paused') {
                userState[customerId] = { stage: 'paused', timestamp: Date.now() };
                console.log(`--> Bot PAUSADO AUTOMATICAMENTE para o chat com: ${customerId}.`);
            }
        }
    }
});

// --- "O ATENDENTE": Ouve as mensagens dos CLIENTES ---
client.on('message', async msg => {
    if (!msg.from.endsWith('@c.us')) return;
    const user = msg.from;

    if (userState[user] && userState[user].stage === 'paused') {
        userState[user].timestamp = Date.now();
        return;
    }

    const db = readDatabase();
    const userData = db[user];
    const chat = await msg.getChat();
    const userMessage = msg.body.toLowerCase().trim();
    const menuTextMessage = `*Digite o número da opção desejada:*\n\n1️⃣ - Falar com uma Vendedora\n2️⃣ - Conhecer o Produto\n3️⃣ - Status do meu Pedido\n4️⃣ - Dúvidas Frequentes`;

    // --- LÓGICA DE ESTADOS ---
    if (userState[user]?.stage === 'awaiting_order_id') {
        const orderId = msg.body.replace(/\D/g, '');
        const userName = userData.name.split(' ')[0];
        
        await chat.sendStateTyping();
        await delay(1500);
        await client.sendMessage(user, `Só um momento, ${userName}, já estou consultando os dados do seu pedido... 🕵️‍♀️`);

        const orderDetails = await findOrderInAirtable(orderId);

        if (orderDetails) {
            let statusMessage = '';
            switch (orderDetails.status) {
                case 'Pendente':
                    statusMessage = `✅ Seu pedido *#${orderId}* foi recebido com sucesso e já está na fila para separação! Nossa equipe já está cuidando de tudo.`;
                    break;
                case 'Embalado':
                    statusMessage = `📦 Ótimas notícias! Seu pedido *#${orderId}* já foi separado e embalado com todo o carinho. ✨ Ele está prontinho, aguardando a coleta para entrega.`;
                    break;
                case 'Saiu para Entrega':
                    statusMessage = `🚚 Prepare-se! Seu pedido *#${orderId}* já foi coletado e está em rota para o seu endereço. Está chegando!`;
                    break;
                case 'Entregue':
                    statusMessage = `🎉 Eba! Nosso sistema confirma que seu pedido *#${orderId}* já foi entregue. Esperamos que ame seus produtos!`;
                    break;
                case 'Falha na entrega':
                    statusMessage = `⚠️ Atenção! O entregador sinalizou uma falha ao tentar entregar seu pedido *#${orderId}*. Por favor, *digite 1* para falar com uma de nossas vendedoras e resolvermos isso o mais rápido possível.`;
                    break;
                default:
                    statusMessage = `O status atual do seu pedido *#${orderId}* é: *${orderDetails.status || 'Não informado'}*.`;
            }

            let response = `${statusMessage}\n\n`;
            if (orderDetails.items && orderDetails.items !== 'Não informado') {
                response += `*Itens:* ${orderDetails.items}\n`;
            }
            if (orderDetails.deliveryDate && orderDetails.deliveryDate !== 'Não informada') {
                response += `*Previsão de Entrega:* ${orderDetails.deliveryDate}`;
            }
            
            await client.sendMessage(user, response.trim());
        } else {
            const notFoundMessage = `Humm, não consegui encontrar nenhum pedido com o número *${orderId}*. 🤔\n\nPor favor, verifique se o número está correto. Se o erro persistir, *digite 1* para falar com uma de nossas vendedoras.`;
            await client.sendMessage(user, notFoundMessage);
        }
        delete userState[user];
        return;
    }
    if (userState[user]?.stage === 'awaiting_name') {
        const capturedName = formatName(msg.body);
        if (capturedName) {
            saveUserData(user, { name: capturedName });
            const qualificationMessage = `Prazer em te conhecer, ${capturedName.split(' ')[0]}! 😊\n\nPara que eu possa te ajudar da melhor forma, me conta uma coisinha: você já conhece o MUTSLIM ou está pesquisando pela primeira vez?`;
            await msg.reply(qualificationMessage);
            userState[user] = { stage: 'awaiting_qualification' };
        } else {
            await msg.reply('Desculpe, não entendi. Por favor, me diga seu primeiro nome.');
        }
        return;
    }
    if (userState[user]?.stage === 'awaiting_qualification') {
        saveUserData(user, { qualification_answer: msg.body });
        delete userState[user];
        const response = `Entendido! Obrigada pela informação.`;
        await msg.reply(response);
        await delay(1500);
        const helpMessage = `Agora, como posso te ajudar?`;
        await chat.sendStateTyping();
        await delay(calculateTypingDelay(helpMessage));
        await client.sendMessage(user, helpMessage);
        await client.sendMessage(user, menuTextMessage);
        return;
    }
    if (userState[user]?.stage === 'awaiting_schedule_preference') {
        const preference = msg.body;
        saveUserData(user, { schedule_preference: preference });
        delete userState[user];
        const response = `Combinado! Deixei anotado aqui sua preferência de contato. Uma de nossas vendedoras te chamará assim que possível. Tenha um ótimo dia!`;
        await msg.reply(response);
        return;
    }
    if (userState[user]?.stage === 'awaiting_cpf') {
        const timeElapsed = Date.now() - (userState[user].timestamp || Date.now());
        const tenMinutes = 10 * 60 * 1000;
        if (timeElapsed > tenMinutes) {
            const response = 'Olá! Notei que você demorou um pouquinho para responder. Para garantir, vamos recomeçar, ok? Se ainda quiser saber o Status do Pedido, pode escolher a opção 3 novamente.';
            delete userState[user];
            await chat.sendStateTyping();
            await delay(calculateTypingDelay(response));
            await client.sendMessage(user, response);
            return;
        }
        const cpf = msg.body;
        const response = `Ok! Recebemos o CPF: *${cpf}*.\n\nEm instantes uma de nossas vendedoras irá verificar o status do seu pedido e te dará um retorno. 👍`;
        await chat.sendStateTyping();
        await delay(calculateTypingDelay(response));
        await client.sendMessage(user, response);
        delete userState[user];
        return;
    }
    if (userState[user]?.stage === 'awaiting_survey_response') {
        console.log(`\n--- FEEDBACK RECEBIDO ---\n* Cliente: ${user}\n* Nota: ${msg.body}\n------------------------`);
        const thanksMessage = `Obrigada pelo seu feedback! Ele é muito importante para nós. ❤️`;
        await msg.reply(thanksMessage);
        delete userState[user];
        return;
    }

    // --- PRIMEIRO CONTATO ---
    if (!userData) {
        const welcomeMessage1 = `Olá! Sou a assistente virtual da MUT Suplementos. 😊`;
        await chat.sendStateTyping();
        await delay(calculateTypingDelay(welcomeMessage1));
        await client.sendMessage(user, welcomeMessage1);
        const welcomeMessage2 = `Para começarmos com um atendimento personalizado, por favor, me diga apenas o seu primeiro nome.`;
        await chat.sendStateTyping();
        await delay(calculateTypingDelay(welcomeMessage2));
        await client.sendMessage(user, welcomeMessage2);
        userState[user] = { stage: 'awaiting_name' };
        return;
    }

    // --- FLUXO NORMAL PARA CLIENTES JÁ CONHECIDOS ---
    const userName = userData.name.split(' ')[0];

    if (userMessage.includes('pedido - mutslim') && userMessage.includes('1 frasco')) {
        const response = `Oii, ${userName}! Vi seu interesse no *MUTSLIM (1 frasco)*. Excelente escolha para começar! ✅\n\n*Valor:* R$ 97,90 + Frete R$ 9,90\n*Duração:* Tratamento para 1 mês.\n\nUma de nossas vendedoras já vai te chamar para finalizar seu pedido.`;
        await chat.sendStateTyping();
        await delay(calculateTypingDelay(response));
        await client.sendMessage(user, response);
        return;
    }
    else if (userMessage.includes('pedido - mutslim') && userMessage.includes('kit 2 meses')) {
        const response = `Olá, ${userName}! Adorei sua escolha pelo *Kit de 2 Meses*! 😍\n\nÉ a opção perfeita para quem já está focada e quer manter a constância para ver os resultados aparecerem. Você está no caminho certo! 💪\n\n*Valor do Kit:* R$ 149,90 + Frete Promocional R$ 4,90\n*Duração:* Tratamento para 2 meses.\n\nUma de nossas vendedoras já está vindo te dar mais informações e te ajudar com tudo, tá bom? ✨`;
        await chat.sendStateTyping();
        await delay(calculateTypingDelay(response));
        await client.sendMessage(user, response);
        return;
    }
    else if (userMessage.includes('pedido - mutslim') && userMessage.includes('kit 3 meses')) {
        const response = `Uau, ${userName}! Você escolheu o nosso kit mais poderoso e completo! 👑\n\nIsso mostra que você está super decidida a conquistar a sua melhor versão. Parabéns pela decisão! Com 3 meses de tratamento, os resultados são realmente incríveis e transformadores. 🎉\n\n*Valor do Kit:* R$ 198,90\n*Benefícios VIP:*\n🚚 Frete Grátis\n🍽️ E-book de Receitas\n🛡️ Garantia de 60 dias\n\nPrepare-se para essa mudança maravilhosa! Uma de nossas vendedoras já vai te passar todos os detalhes. Você vai amar! 💕`;
        await chat.sendStateTyping();
        await delay(calculateTypingDelay(response));
        await client.sendMessage(user, response);
        return;
    }
    else if (userMessage.includes('atendimento mutslim') && userMessage.includes('saber mais sobre o mutslim')) {
        const menuMessage = `Olá, *${userName}*! Que bom te ver de novo. Vi que você veio do nosso site e quer saber mais sobre o MUTSLIM. Estou aqui para te ajudar. ✨`;
        await chat.sendStateTyping();
        await delay(calculateTypingDelay(menuMessage));
        await client.sendMessage(user, menuMessage);
        await client.sendMessage(user, menuTextMessage);
        return;
    }

    if (userMessage === '1' || userMessage.includes('vendedora')) {
        if (isWithinBusinessHours()) {
            const response = 'Combinado! Em instantes uma de nossas *vendedoras* entrará em contato com você por aqui. Por favor, aguarde um momento. 😊';
            await chat.sendStateTyping();
            await delay(calculateTypingDelay(response));
            await client.sendMessage(user, response);
        } else {
            const outOfHoursMessage = `Olá, ${userName}! Recebemos seu contato. ❤️\n\nNossa equipe já encerrou por hoje, mas sua mensagem é nossa prioridade! Fique de olho, pois uma vendedora pode te responder ainda hoje se houver uma brecha. Caso contrário, retornaremos no início do próximo dia útil.`;
            await chat.sendStateTyping();
            await delay(calculateTypingDelay(outOfHoursMessage));
            await client.sendMessage(user, outOfHoursMessage);
            const scheduleMessage = `Para agilizar, podemos agendar um contato para amanhã. Qual período é melhor para você?\n\n*Digite Manhã* (9:30-12:00) ou *Tarde* (13:00-17:00)`;
            await chat.sendStateTyping();
            await delay(calculateTypingDelay(scheduleMessage));
            await client.sendMessage(user, scheduleMessage);
            userState[user] = { stage: 'awaiting_schedule_preference' };
        }
    }
    else if (userMessage === '2' || userMessage.includes('conhecer') || userMessage.includes('produto')) {
        const response = 'Que ótimo! Para conhecer todos os detalhes do nosso produto e fazer sua compra, acesse nossa página oficial. É rápido e seguro! 🌟\n\nhttps://mutsuplementos.com.br/mutslim/';
        await chat.sendStateTyping();
        await delay(calculateTypingDelay(response));
        await client.sendMessage(user, response);
        userState[user] = { stage: 'interest_shown', timestamp: Date.now() };
    }
    else if (userMessage === '3' || userMessage.includes('status') || userMessage.includes('pedido')) {
        const response = `Claro, ${userName}! Para que eu possa localizar seu pedido, por favor, *digite o número do seu pedido* (ex: 1054).`;
        await chat.sendStateTyping();
        await delay(calculateTypingDelay(response));
        await client.sendMessage(user, response);
        userState[user] = { stage: 'awaiting_order_id' };
    }
    else if (userMessage === '4' || userMessage.includes('duvida') || userMessage.includes('dúvidas')) {
        const faqMessage = `Com certeza, ${userName}! Separei as dúvidas mais comuns sobre o MUTSLIM:\n\n*1. Como o MUTSLIM age no corpo?* 🎯\nEle funciona como um acelerador de metabolismo, auxiliando na queima de gordura e na redução do inchaço. Seus ingredientes naturais, como o Picolinato de Cromo e o Psyllium, ajudam a diminuir a vontade de comer doces e a promover a sensação de saciedade.\n\n*2. Como devo tomar?* 💊\nÉ super simples! Apenas 2 cápsulas por dia, uma cerca de 30 minutos antes do almoço e outra antes do jantar. Para melhores resultados, recomendamos o uso contínuo por pelo menos 3 meses.\n\n*3. Em quanto tempo vejo resultados?* ✨\nMuitas de nossas clientes relatam sentir mais disposição e menos inchaço já na primeira semana! Resultados mais expressivos na balança costumam aparecer a partir de 30 dias de uso contínuo, combinado com um estilo de vida saudável.\n\n*4. É aprovado pela ANVISA?* ✅\nSim! O MUTSLIM é totalmente seguro, produzido em laboratório certificado e aprovado pela ANVISA nos termos da RDC 240 de 26/07/2018.`;
        await chat.sendStateTyping();
        await delay(calculateTypingDelay(faqMessage));
        await client.sendMessage(user, faqMessage);
        
        await delay(4000);
        const followupFaq = `Espero que isso tenha ajudado a esclarecer suas dúvidas! 😊\n\nSe você ainda tiver qualquer outra pergunta ou já quiser garantir o seu kit, *digite 1* para falar com uma de nossas vendedoras especialistas.`;
        await chat.sendStateTyping();
        await delay(calculateTypingDelay(followupFaq));
        await client.sendMessage(user, followupFaq);
    }
    else if (userMessage.match(/^(oi|oie|ol[áa]|bom dia|boa tarde|boa noite|e a[íi]|opa|come[çc]ar|tudo bem|tudo bom|gostaria de saber|informa[çc][õo]es|d[úu]vida|ajuda|pre[çc]o|valor|quanto custa|como funciona|dispon[íi]vel|quero|produto|or[çc]amento|mutslim|o que [eé]|pra que serve)/i)) {
        const welcomeBackMessage = `Olá, *${userName}*! Que bom te ver de novo. 👋 Como posso te ajudar hoje?`;
        await chat.sendStateTyping();
        await delay(calculateTypingDelay(welcomeBackMessage));
        await client.sendMessage(user, welcomeBackMessage);
        await client.sendMessage(user, menuTextMessage);
    }
    else {
        const errorMessage = `Oi, *${userName}*! Não entendi muito bem sua mensagem. 🤔\n\nPara que eu possa te ajudar, por favor, escolha uma das opções abaixo.`;
        await chat.sendStateTyping();
        await delay(calculateTypingDelay(errorMessage));
        await client.sendMessage(user, errorMessage);
        await client.sendMessage(user, menuTextMessage);
    }
});