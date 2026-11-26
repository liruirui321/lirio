#!/usr/bin/env python3
"""
Generate 24 graded listening materials (12 L1 Beginner A1-A2 + 12 L2 High School A2-B1)
with natural edge_tts audio, sample-exact sentence timestamps, and Chinese translations,
saving .mp3 assets and writing standard .abmac + .meta.json files into the Lirio library.
"""

import asyncio
import base64
import datetime
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import uuid
import wave

import edge_tts

FFMPEG = "/opt/homebrew/bin/ffmpeg"
FFPROBE = "/opt/homebrew/bin/ffprobe"
SAMPLE_RATE = 24000

MATERIALS_DIR = pathlib.Path("/Users/cherry/AbobooMac/materials/graded_l1_l2")
LIBRARY_DIR = pathlib.Path.home() / "Library/Application Support/local.aboboo.community/library"

MATERIALS = [
    # ==================== L1: 初学者 (A1-A2, 12 份, 10-12 句短句, rate="-14%") ====================
    {
        "slug": "l1_01_first_meeting",
        "tier": "L1",
        "name": "[L1] 日常对话 · 初次见面与自我介绍",
        "rate": "-14%",
        "gap_sec": 0.42,
        "sentences": [
            ("en-US-JennyNeural", "Hi, my name is Emma. Nice to meet you.", "你好，我叫艾玛。很高兴认识你。"),
            ("en-US-GuyNeural", "Nice to meet you too, Emma. I am Ben.", "我也很高兴认识你，艾玛。我是本。"),
            ("en-US-JennyNeural", "Where are you from, Ben?", "本，你是哪里人？"),
            ("en-US-GuyNeural", "I am from Seattle, in the west.", "我来自西部的西雅图。"),
            ("en-US-JennyNeural", "Oh, cool! Is this your first week here?", "哦，真棒！这是你来这里的第一周吗？"),
            ("en-US-GuyNeural", "Yes, I moved here on Monday morning.", "是的，我周一早上刚搬过来。"),
            ("en-US-JennyNeural", "Welcome! Are you a student at the college?", "欢迎你！你是这所学院的学生吗？"),
            ("en-US-GuyNeural", "No, I work at a small design shop nearby.", "不是，我在附近一家小设计店工作。"),
            ("en-US-JennyNeural", "That sounds fun. I study music here.", "听起来很有趣。我在这里学音乐。"),
            ("en-US-GuyNeural", "Do you like this neighborhood so far?", "到目前为止你喜欢这个街区吗？"),
            ("en-US-JennyNeural", "Yes, the people are friendly and warm.", "喜欢，这里的人都很友好热情。"),
            ("en-US-GuyNeural", "Let us grab tea together after work sometime.", "改天下班后我们一起喝杯茶吧。"),
        ],
    },
    {
        "slug": "l1_02_coffee_shop",
        "tier": "L1",
        "name": "[L1] 生活场景 · 咖啡店点单",
        "rate": "-14%",
        "gap_sec": 0.42,
        "sentences": [
            ("en-US-AriaNeural", "Good morning! What can I get for you today?", "早上好！今天想点些什么？"),
            ("en-US-AndrewNeural", "Hi, I would like a medium latte, please.", "你好，我想要一杯中杯拿铁。"),
            ("en-US-AriaNeural", "Would you like that hot or iced?", "请问要热的还是冰的？"),
            ("en-US-AndrewNeural", "Hot, please. Can you use oat milk?", "热的，谢谢。可以换成燕麦奶吗？"),
            ("en-US-AriaNeural", "Sure, oat milk is no problem at all.", "当然可以，换燕麦奶没问题。"),
            ("en-US-AndrewNeural", "Great. Do you have any fresh muffins?", "太好了。你们有新鲜的玛芬蛋糕吗？"),
            ("en-US-AriaNeural", "Yes, we have blueberry and lemon muffins.", "有的，我们有蓝莓味和柠檬味的玛芬。"),
            ("en-US-AndrewNeural", "I will take one blueberry muffin, please.", "请给我拿一个蓝莓玛芬。"),
            ("en-US-AriaNeural", "Is that for here or to go?", "请问是在店里吃还是打包带走？"),
            ("en-US-AndrewNeural", "To go, please. I need to catch a bus.", "打包带走，谢谢。我得去赶公交车。"),
            ("en-US-AriaNeural", "That comes to seven dollars and fifty cents.", "一共是七美元五十美分。"),
            ("en-US-AndrewNeural", "Here is my card. Thank you very much.", "给你刷卡。非常感谢。"),
        ],
    },
    {
        "slug": "l1_03_subway_directions",
        "tier": "L1",
        "name": "[L1] 出行问路 · 地铁站指路",
        "rate": "-14%",
        "gap_sec": 0.42,
        "sentences": [
            ("en-GB-SoniaNeural", "Excuse me, could you help me for a second?", "打扰一下，能帮我个忙吗？"),
            ("en-GB-RyanNeural", "Of course. Where do you want to go?", "当然可以。你想去哪里？"),
            ("en-GB-SoniaNeural", "I am looking for the nearest underground station.", "我在找最近的地铁站。"),
            ("en-GB-RyanNeural", "Walk straight down this street for two blocks.", "沿着这条街直走两个街区。"),
            ("en-GB-SoniaNeural", "Okay, two blocks straight ahead. Then what?", "好的，直走两个街区。然后呢？"),
            ("en-GB-RyanNeural", "Turn left at the big red bookshop.", "在那家红色的大书店处左转。"),
            ("en-GB-SoniaNeural", "Turn left at the bookshop. Got it.", "在书店处左转。明白了。"),
            ("en-GB-RyanNeural", "You will see the blue sign right across the road.", "你就会看到马路正对面的蓝色地铁标志。"),
            ("en-GB-SoniaNeural", "Is it far to walk from here?", "从这里走过去远吗？"),
            ("en-GB-RyanNeural", "Not at all. It only takes about five minutes.", "一点也不远，大概只要五分钟。"),
            ("en-GB-SoniaNeural", "Thank you so much for your help!", "非常感谢你的帮助！"),
        ],
    },
    {
        "slug": "l1_04_supermarket_fruit",
        "tier": "L1",
        "name": "[L1] 购物买菜 · 超市买水果结账",
        "rate": "-14%",
        "gap_sec": 0.42,
        "sentences": [
            ("en-US-JennyNeural", "Hi there, are the sweet strawberries on sale today?", "你好，今天这种甜草莓打折吗？"),
            ("en-US-GuyNeural", "Yes, they are three dollars a box today.", "是的，今天三美元一盒。"),
            ("en-US-JennyNeural", "They look fresh. I will take two boxes.", "看起来很新鲜。我要两盒。"),
            ("en-US-GuyNeural", "Do you also want some yellow bananas?", "你还需要买一些黄香蕉吗？"),
            ("en-US-JennyNeural", "Yes, please give me a small bunch.", "好的，请给我一小串。"),
            ("en-US-GuyNeural", "How about apples? These red ones are crisp.", "苹果怎么样？这些红苹果很脆。"),
            ("en-US-JennyNeural", "Sure, I need four red apples for lunch.", "好呀，我午餐需要四个红苹果。"),
            ("en-US-GuyNeural", "Would you like a paper bag for your fruit?", "需要一个纸袋来装这些水果吗？"),
            ("en-US-JennyNeural", "No thanks, I brought my own cloth bag.", "不用了谢谢，我自己带了布袋。"),
            ("en-US-GuyNeural", "Great choice! Your total is eleven dollars.", "真环保！一共十一美元。"),
            ("en-US-JennyNeural", "Here you go. Have a lovely afternoon!", "给你钱。祝你下午愉快！"),
        ],
    },
    {
        "slug": "l1_05_restaurant_order",
        "tier": "L1",
        "name": "[L1] 餐厅就餐 · 餐厅点餐与结账",
        "rate": "-14%",
        "gap_sec": 0.42,
        "sentences": [
            ("en-GB-LibbyNeural", "Good evening! Do you have a table for two?", "晚上好！请问有两人桌吗？"),
            ("en-GB-RyanNeural", "Yes, please follow me to the window seat.", "有的，请跟我来这边的靠窗座位。"),
            ("en-GB-LibbyNeural", "Thank you. May we see the menu, please?", "谢谢。请给我们看一下菜单好吗？"),
            ("en-GB-RyanNeural", "Here you go. Today's soup is tomato.", "给你菜单。今天的例汤是番茄汤。"),
            ("en-GB-LibbyNeural", "I would like a bowl of tomato soup first.", "我想先要一碗番茄汤。"),
            ("en-GB-RyanNeural", "And what would you like for the main dish?", "那主菜想点什么呢？"),
            ("en-GB-LibbyNeural", "Grilled fish with rice sounds delicious.", "烤鱼配米饭听起来很美味。"),
            ("en-GB-RyanNeural", "Would you care for something to drink?", "需要点些什么喝的吗？"),
            ("en-GB-LibbyNeural", "Just two glasses of warm water, please.", "请来两杯温水就好，谢谢。"),
            ("en-GB-RyanNeural", "Certainly. Your food will be ready soon.", "好的，您的餐点很快就好。"),
            ("en-GB-LibbyNeural", "Excuse me, could we have the bill now?", "不好意思，我们现在可以结账了吗？"),
        ],
    },
    {
        "slug": "l1_06_weekend_picnic",
        "tier": "L1",
        "name": "[L1] 周末天气 · 公园野餐计划",
        "rate": "-14%",
        "gap_sec": 0.42,
        "sentences": [
            ("en-US-AriaNeural", "Look at the blue sky! It is so sunny today.", "看那蓝天！今天阳光真好。"),
            ("en-US-AndrewNeural", "Yes, it is warm and breezy outside.", "是啊，外面暖和又有微风。"),
            ("en-US-AriaNeural", "What is the weather forecast for Saturday?", "周六的天气预报怎么说？"),
            ("en-US-AndrewNeural", "It says sunny all day, around twenty-two degrees.", "预报说全天晴朗，大约二十二度。"),
            ("en-US-AriaNeural", "That is perfect weather for a park picnic!", "这真是去公园野餐的完美天气！"),
            ("en-US-AndrewNeural", "I agree. Which park should we go to?", "同意。我们去哪个公园好呢？"),
            ("en-US-AriaNeural", "Let us go to Green Lake Park at noon.", "我们中午去绿湖公园吧。"),
            ("en-US-AndrewNeural", "Sounds great. What food should I bring?", "听起来不错。我应该带什么吃的？"),
            ("en-US-AriaNeural", "Can you bring some sandwiches and orange juice?", "你能带些三明治和橙汁吗？"),
            ("en-US-AndrewNeural", "Sure! I will also pack a large picnic mat.", "没问题！我还会带上一块大野餐垫。"),
            ("en-US-AriaNeural", "Awesome, see you at the south gate at twelve!", "太棒了，十二点在南门见！"),
        ],
    },
    {
        "slug": "l1_07_campus_library",
        "tier": "L1",
        "name": "[L1] 校园日常 · 图书馆借书",
        "rate": "-14%",
        "gap_sec": 0.42,
        "sentences": [
            ("en-GB-SoniaNeural", "Hello! I would like to borrow these three books.", "你好！我想借这三本书。"),
            ("en-GB-RyanNeural", "Sure, may I see your student card, please?", "好的，请出示一下你的学生证好吗？"),
            ("en-GB-SoniaNeural", "Here is my card. It is my first time borrowing.", "这是我的卡。我还是第一次借书。"),
            ("en-GB-RyanNeural", "Welcome to the library! Let me scan them.", "欢迎来到图书馆！我来扫描一下书。"),
            ("en-GB-SoniaNeural", "How long can I keep these books?", "这些书我可以借多久？"),
            ("en-GB-RyanNeural", "You can keep them for fourteen days.", "你可以借阅十四天。"),
            ("en-GB-SoniaNeural", "What if I need a few more days to finish?", "如果我还需要多几天才能看完怎么办？"),
            ("en-GB-RyanNeural", "You can renew them online before the due date.", "你可以在到期前直接在网上续借。"),
            ("en-GB-SoniaNeural", "Is the reading room open on Sunday?", "阅览室周日开门吗？"),
            ("en-GB-RyanNeural", "Yes, it is open from nine to six on weekends.", "开的，周末上午九点到下午六点开放。"),
            ("en-GB-SoniaNeural", "Thank you! Have a nice day.", "谢谢你！祝你今天愉快。"),
        ],
    },
    {
        "slug": "l1_08_seeing_doctor",
        "tier": "L1",
        "name": "[L1] 健康就医 · 感冒看医生",
        "rate": "-14%",
        "gap_sec": 0.42,
        "sentences": [
            ("en-US-AndrewNeural", "Come in and have a seat. What seems wrong?", "请进并坐下。哪里不舒服？"),
            ("en-US-JennyNeural", "I have a sore throat and a runny nose.", "我喉咙痛，还一直流鼻涕。"),
            ("en-US-AndrewNeural", "When did you start feeling sick?", "你什么时候开始觉得不舒服的？"),
            ("en-US-JennyNeural", "Two days ago, after I walked in the rain.", "两天前，我淋了一场雨之后。"),
            ("en-US-AndrewNeural", "Do you also have a fever or a cough?", "你还有发烧或者咳嗽吗？"),
            ("en-US-JennyNeural", "A mild cough, mostly at night.", "有一点轻咳，主要是在晚上。"),
            ("en-US-AndrewNeural", "Let me check your temperature. It looks normal.", "我量一下你的体温。看起来是正常的。"),
            ("en-US-JennyNeural", "That is good news. Do I need medicine?", "那太好了。我需要吃药吗？"),
            ("en-US-AndrewNeural", "Take these throat drops three times a day.", "含这种润喉片，每天三次。"),
            ("en-US-JennyNeural", "Okay. Anything else I should do?", "好的。还有其他要注意的吗？"),
            ("en-US-AndrewNeural", "Drink plenty of warm water and get enough sleep.", "多喝温水，保证充足的睡眠。"),
        ],
    },
    {
        "slug": "l1_09_hotel_checkin",
        "tier": "L1",
        "name": "[L1] 旅行住宿 · 酒店办理入住",
        "rate": "-14%",
        "gap_sec": 0.42,
        "sentences": [
            ("en-GB-RyanNeural", "Good afternoon! Welcome to River View Hotel.", "下午好！欢迎光临河景酒店。"),
            ("en-GB-LibbyNeural", "Hi, I have a reservation under Claire Taylor.", "你好，我用克莱尔·泰勒的名字预订了房间。"),
            ("en-GB-RyanNeural", "Yes, I see your booking for two nights.", "好的，我看到您预订了两晚住宿。"),
            ("en-GB-LibbyNeural", "May I have a quiet room away from the street?", "能给我安排一间远离街道的安静房间吗？"),
            ("en-GB-RyanNeural", "Sure, room four-oh-eight faces our garden.", "没问题，408号房间面向我们的花园。"),
            ("en-GB-LibbyNeural", "That sounds lovely. Is breakfast included?", "听起来很棒。包含早餐吗？"),
            ("en-GB-RyanNeural", "Yes, breakfast starts at seven on the first floor.", "包含的，早餐七点在一楼开始供应。"),
            ("en-GB-LibbyNeural", "Could you also share the Wi-Fi password?", "能也告诉我一下无线网密码吗？"),
            ("en-GB-RyanNeural", "It is printed right inside your key card holder.", "密码就印在您的房卡套里面。"),
            ("en-GB-LibbyNeural", "Thank you. Where is the lift, please?", "谢谢你。请问电梯在哪里？"),
            ("en-GB-RyanNeural", "Just around the corner on your right.", "就在您右手边转角处。"),
        ],
    },
    {
        "slug": "l1_10_airport_checkin",
        "tier": "L1",
        "name": "[L1] 交通出行 · 机场值机与托运",
        "rate": "-14%",
        "gap_sec": 0.42,
        "sentences": [
            ("en-US-AriaNeural", "Hello! Where are you flying today?", "您好！请问您今天飞往哪里？"),
            ("en-US-GuyNeural", "I am flying to Chicago on flight two-four-zero.", "我乘坐240次航班飞往芝加哥。"),
            ("en-US-AriaNeural", "May I see your passport and ticket, please?", "请出示您的护照和机票好吗？"),
            ("en-US-GuyNeural", "Here they are. Can I get a window seat?", "给您。请问可以给我一个靠窗座位吗？"),
            ("en-US-AriaNeural", "Let me check. Yes, seat fourteen-A is free.", "我查一下。可以，14A座还是空的。"),
            ("en-US-GuyNeural", "Great, thank you! I also have one suitcase.", "太好了，谢谢！我还有一个行李箱要托运。"),
            ("en-US-AriaNeural", "Please place your bag on the scale.", "请把您的箱子放到秤上。"),
            ("en-US-GuyNeural", "Is the weight okay for this flight?", "重量符合这次航班的要求吗？"),
            ("en-US-AriaNeural", "Yes, eighteen kilos is well within the limit.", "是的，十八公斤完全在限额之内。"),
            ("en-US-GuyNeural", "Wonderful. Which gate should I go to?", "太棒了。我应该去哪个登机口？"),
            ("en-US-AriaNeural", "Your flight leaves from Gate B-twelve at ten thirty.", "您的航班十点半从 B12 登机口起飞。"),
        ],
    },
    {
        "slug": "l1_11_daily_routine",
        "tier": "L1",
        "name": "[L1] 慢速短文 · 我的一天与作息",
        "rate": "-14%",
        "gap_sec": 0.42,
        "sentences": [
            ("en-US-JennyNeural", "On weekdays, I wake up early at seven o'clock.", "在工作日，我每天七点钟准时起床。"),
            ("en-US-JennyNeural", "I open the window to let fresh air in.", "我打开窗户让新鲜空气吹进来。"),
            ("en-US-JennyNeural", "After brushing my teeth, I make a simple breakfast.", "刷完牙后，我会做一顿简单的早餐。"),
            ("en-US-JennyNeural", "I usually eat two eggs and a piece of toast.", "我通常会吃两个鸡蛋和一片烤面包。"),
            ("en-US-JennyNeural", "At eight fifteen, I walk to the nearby subway station.", "八点一刻，我步行去附近的地铁站。"),
            ("en-US-JennyNeural", "During the ride, I listen to short English stories.", "坐地铁时，我会听几段简短的英语故事。"),
            ("en-US-JennyNeural", "My classes start at nine and finish at four.", "我的课从九点开始，到下午四点结束。"),
            ("en-US-JennyNeural", "In the evening, I take a short walk outside.", "傍晚时分，我会在室外散一小会儿步。"),
            ("en-US-JennyNeural", "Then I read a book for half an hour.", "接着我会看半小时的书。"),
            ("en-US-JennyNeural", "I go to bed around ten thirty to sleep well.", "我大概十点半睡觉，好睡个好觉。"),
        ],
    },
    {
        "slug": "l1_12_four_seasons",
        "tier": "L1",
        "name": "[L1] 慢速短文 · 家乡的四季天气",
        "rate": "-14%",
        "gap_sec": 0.42,
        "sentences": [
            ("en-GB-SoniaNeural", "My hometown has four very clear seasons every year.", "我的家乡每年都有非常分明的四个季节。"),
            ("en-GB-SoniaNeural", "Spring begins in March when green leaves return.", "春天从三月开始，绿叶重新长了出来。"),
            ("en-GB-SoniaNeural", "The mornings are cool, and flowers bloom along the river.", "清晨有些凉爽，河边开满了鲜花。"),
            ("en-GB-SoniaNeural", "Summer arrives in June with bright sun and long days.", "夏天在六月到来，阳光明媚，白昼变长。"),
            ("en-GB-SoniaNeural", "Children love eating cold watermelon in the afternoon.", "孩子们喜欢在午后吃冰镇西瓜。"),
            ("en-GB-SoniaNeural", "Autumn is my favorite season because the sky stays clear.", "秋天是我最喜欢的季节，因为天空总是很晴朗。"),
            ("en-GB-SoniaNeural", "Golden leaves cover the quiet streets in October.", "十月里，金黄的落叶铺满了安静的街道。"),
            ("en-GB-SoniaNeural", "Winter brings cold winds and soft white snow in January.", "一月的冬天会带来寒风和松软的白雪。"),
            ("en-GB-SoniaNeural", "Families stay inside, drink hot tea, and talk together.", "家人们待在屋里，喝着热茶，一起聊天。"),
            ("en-GB-SoniaNeural", "Every season gives the town its own special charm.", "每一个季节都赋予这座小城独特的魅力。"),
        ],
    },

    # ==================== L2: 高中生 (A2-B1, 12 份, 12-14 句中长句, rate="-6%") ====================
    {
        "slug": "l2_01_morning_reading",
        "tier": "L2",
        "name": "[L2] 学习习惯 · 早起阅读如何培养专注力",
        "rate": "-6%",
        "gap_sec": 0.38,
        "sentences": [
            ("en-US-AndrewNeural", "Many students notice that their minds feel tired before noon even after sleeping enough.", "许多学生发现，即使睡够了觉，到了中午前大脑还是容易感到疲惫。"),
            ("en-US-AndrewNeural", "Often, the real reason is checking messages and short videos right after waking up.", "通常来说，真正的原因在于一醒来就立刻刷消息和短视频。"),
            ("en-US-AndrewNeural", "That rapid flood of notifications trains your brain to chase quick distractions all day.", "那一连串的通知提示会训练大脑一整天都在追逐短暂的刺激。"),
            ("en-US-AndrewNeural", "Instead, try keeping the first twenty minutes of your morning completely phone-free.", "相反，试着让早晨醒来的前二十分钟完全不碰手机。"),
            ("en-US-AndrewNeural", "Make a cup of warm water or tea, and sit down with a printed book or article.", "倒一杯温水或茶，坐下来翻开一本纸质书或一篇文章。"),
            ("en-US-AndrewNeural", "Reading even six or eight pages calmly helps your thoughts settle into a steady rhythm.", "哪怕只是静心读上六到八页，也能帮助思绪进入稳定的节奏。"),
            ("en-US-AndrewNeural", "You do not need to memorize every single sentence or finish a whole chapter.", "你不需要背下每一句话，也不必一口气读完整整一章。"),
            ("en-US-AndrewNeural", "What matters is giving your attention one clear object without switching tabs.", "真正重要的是让注意力专注在一个清晰的对象上，不去频繁切换画面。"),
            ("en-US-AndrewNeural", "After two weeks, most people find it much easier to start difficult homework on time.", "坚持两周后，大多数人会发现按时开始做难题作业变得轻松了许多。"),
            ("en-US-AndrewNeural", "They also remember new vocabulary better when their minds are rested and unhurried.", "当头脑充分休息且不急躁时，记忆新单词的效果也会好得多。"),
            ("en-US-AndrewNeural", "Small morning routines quietly protect your focus for the rest of the day.", "清晨的小习惯会在不知不觉中保护你一整天的专注力。"),
            ("en-US-AndrewNeural", "Begin tomorrow with ten quiet minutes, and notice how different your study feels.", "明天就从安静的十分钟开始吧，感受一下学习状态有什么不同。"),
        ],
    },
    {
        "slug": "l2_02_exam_anxiety",
        "tier": "L2",
        "name": "[L2] 校园生活 · 缓解考前焦虑的实用方法",
        "rate": "-6%",
        "gap_sec": 0.38,
        "sentences": [
            ("en-GB-SoniaNeural", "Feeling nervous before an important exam is completely normal, even for top students.", "在大考前感到紧张是非常正常的现象，哪怕是成绩优异的学生也一样。"),
            ("en-GB-SoniaNeural", "A small amount of tension actually keeps you alert, yet too much worry clouds your memory.", "适度的紧张感反而能让你保持警觉，但过度焦虑却会干扰记忆提取。"),
            ("en-GB-SoniaNeural", "One simple mistake students make is staying up past midnight to cram new material.", "学生常犯的一个错误，就是熬夜到半夜以后去硬塞全新的知识点。"),
            ("en-GB-SoniaNeural", "Sleep is when your brain organizes what you learned and turns short-term notes into recall.", "睡眠恰恰是大脑整理所学内容、把短期记忆转化为稳固提取能力的关键阶段。"),
            ("en-GB-SoniaNeural", "Two days before the test, shift from learning brand-new topics to reviewing past errors.", "考前两天，要把重点从死磕新题型转到复盘此前的错题上。"),
            ("en-GB-SoniaNeural", "Write down the three mistakes you repeat most often and keep that list very brief.", "写下你最常重复犯的三个错误，并让这份清单尽量简短清晰。"),
            ("en-GB-SoniaNeural", "On the evening before the exam, pack your pens, ID card, and water bottle early.", "考试前一晚，提前把笔、证件和水壶都收拾妥当。"),
            ("en-GB-SoniaNeural", "If your heart beats fast in the exam hall, pause for ten seconds and breathe slowly.", "如果在考场里心跳加快，不妨停下十秒钟，慢慢深呼吸。"),
            ("en-GB-SoniaNeural", "Read the first question carefully instead of worrying about your final score.", "把注意力放在认真读懂第一道题上，而不是去预想最终的分数。"),
            ("en-GB-SoniaNeural", "When a tough question blocks you, skip it calmly and return after answering easier ones.", "遇到卡壳的难题时平静跳过，先把有把握的题目做完再回头思考。"),
            ("en-GB-SoniaNeural", "Confidence comes from clear preparation and steady habits, not from worrying harder.", "自信来源于扎实的准备和稳健的习惯，而不是反复担忧。"),
            ("en-GB-SoniaNeural", "Trust the hours you have already put in, and treat the test as a regular practice.", "相信自己此前投入的努力，把这场考试当作一次平常的练习就好。"),
        ],
    },
    {
        "slug": "l2_03_screen_detox",
        "tier": "L2",
        "name": "[L2] 数字生活 · 减少刷手机的一周实验",
        "rate": "-6%",
        "gap_sec": 0.38,
        "sentences": [
            ("en-US-AriaNeural", "Hey Sam, you look unusually relaxed today. Did you finish your exams?", "嘿，山姆，你今天看起来格外轻松啊，是考完试了吗？"),
            ("en-US-GuyNeural", "Not yet, but I tried a small rule this week to cut my daily screen time.", "还没呢，不过我这周试了一个小规定，来减少每天看屏幕的时间。"),
            ("en-US-AriaNeural", "Oh, really? How many hours were you spending on your phone before?", "哦，真的吗？你以前每天在手机上要花多少小时？"),
            ("en-US-GuyNeural", "About five hours a day, mostly scrolling between homework and late at night.", "每天大概要五小时，主要是在写作业间隙和深夜里一直刷手机。"),
            ("en-US-AriaNeural", "Five hours adds up fast. What did you change first?", "五个小时不知不觉就过去了。你最先改变了哪一点？"),
            ("en-US-GuyNeural", "First, I turned off badges and pop-up alerts for every entertainment app.", "首先，我关掉了所有娱乐应用的角标红点和弹窗提醒。"),
            ("en-US-AriaNeural", "Did it feel strange not hearing your phone buzz every five minutes?", "手机不再每隔五分钟响一次，一开始会不会觉得很不习惯？"),
            ("en-US-GuyNeural", "The first two days were hard because my hand kept reaching for my pocket.", "头两天确实很难熬，因为我的手总是忍不住往口袋里摸。"),
            ("en-US-AriaNeural", "And what happened once you got past the second day?", "那熬过第二天之后有什么变化吗？"),
            ("en-US-GuyNeural", "I suddenly had an extra hour each evening to cook dinner and practice guitar.", "我突然发现每天晚上多出整整一小时，可以用来做晚饭和练吉他。"),
            ("en-US-AriaNeural", "That sounds way more satisfying than watching random clips before sleep.", "那听起来比睡前漫无目的地刷短视频充实多了。"),
            ("en-US-GuyNeural", "Totally. I am keeping the rule for the whole month now.", "确实如此，我打算整个月都继续坚持这个规定。"),
        ],
    },
    {
        "slug": "l2_04_home_cooking",
        "tier": "L2",
        "name": "[L2] 健康饮食 · 自己做饭的乐趣与收获",
        "rate": "-6%",
        "gap_sec": 0.38,
        "sentences": [
            ("en-GB-LibbyNeural", "Ordering takeaway food is convenient on busy evenings, yet eating it daily gets tiring.", "忙碌的晚上点外卖确实方便，但天天吃外卖很快就会让人觉得腻。"),
            ("en-GB-LibbyNeural", "Learning to cook three or four simple dishes at home is surprisingly empowering.", "学会自己在家做三四道简单的家常菜，其实会带来很强的掌控感。"),
            ("en-GB-LibbyNeural", "You do not need fancy kitchen tools or rare ingredients to start cooking well.", "想要做好入门料理，并不需要昂贵的厨具或稀有的食材。"),
            ("en-GB-LibbyNeural", "A single pan, fresh vegetables, eggs, and noodles are enough for a balanced meal.", "只要一口平底锅，加上新鲜蔬菜、鸡蛋和面条，就足够做出一顿营养均衡的饭菜。"),
            ("en-GB-LibbyNeural", "Cooking also saves a noticeable amount of money over a single school term.", "哪怕只算一个学期，自己做饭也能省下一笔相当可观的开销。"),
            ("en-GB-LibbyNeural", "More importantly, you know exactly how much oil, salt, and sugar go into your bowl.", "更重要的是，你清楚地知道自己碗里放了多少油、盐和糖。"),
            ("en-GB-LibbyNeural", "Chopping onions and listening to the sizzle in the pan helps you step away from study stress.", "切切洋葱、听着锅里滋滋作响的声音，还能帮你暂时从学习压力中抽离出来。"),
            ("en-GB-LibbyNeural", "Of course, the first few tries might taste a little salty or look slightly burned.", "当然，头几次尝试可能会稍微偏咸或者有一点煎糊。"),
            ("en-GB-LibbyNeural", "Even then, adjusting the heat next time feels like solving a friendly everyday puzzle.", "即便如此，下次调整一下火候的过程，也像在解一道轻松的日常小谜题。"),
            ("en-GB-LibbyNeural", "Cooking a warm meal for family or friends on Sunday creates easy moments to talk.", "周日为家人或朋友做一顿热腾腾的饭菜，也能自然地创造聊天相聚的时刻。"),
            ("en-GB-LibbyNeural", "Start with one reliable breakfast recipe, and build your skills dish by dish.", "先从一份拿手的早餐食谱开始，一道一道地积累自己的厨艺吧。"),
            ("en-GB-LibbyNeural", "By next month, the kitchen will feel less like a chore and more like a reward.", "到了下个月，走进厨房就不会像是一项负担，而更像是一份奖赏。"),
        ],
    },
    {
        "slug": "l2_05_green_cycling",
        "tier": "L2",
        "name": "[L2] 绿色出行 · 骑行通勤与低碳校园",
        "rate": "-6%",
        "gap_sec": 0.38,
        "sentences": [
            ("en-AU-NatashaNeural", "Every morning around eight o'clock, traffic outside high schools can move slower than walking.", "每天早上八点左右，中学校门外的车流往往比步行还要缓慢。"),
            ("en-AU-NatashaNeural", "For trips under five kilometers, riding a bicycle is often faster than waiting in cars.", "对于五公里以内的短途出行，骑自行车常常比坐在汽车里堵车还要快。"),
            ("en-AU-NatashaNeural", "Cycling wakes up your body gently with cool air and steady movement before class starts.", "骑行能让你在走进教室前，借助清晨的微风和适度运动温柔地唤醒身体。"),
            ("en-AU-NatashaNeural", "Students who ride to school frequently report feeling more awake during first-period lessons.", "经常骑车上学的学生往往表示，自己在第一节课时头脑更加清醒。"),
            ("en-AU-NatashaNeural", "Beyond personal health, choosing two wheels over fuel cuts noise and lowers local emissions.", "除了有益个人健康，选择两轮出行而非燃油汽车，还能减少噪音并降低当地碳排放。"),
            ("en-AU-NatashaNeural", "Many campuses now build shaded bike racks and separate lanes to make riding safer.", "如今许多校园都修建了带遮阳棚的停放区和独立骑行道，让骑车更安全。"),
            ("en-AU-NatashaNeural", "Still, safety habits remain essential whenever you share streets with buses and pedestrians.", "不过，每当你与公交车和行人共用道路时，安全意识依然必不可少。"),
            ("en-AU-NatashaNeural", "Always wear a fitted helmet, check your brakes regularly, and avoid using headphones while riding.", "务必佩戴合头的安全头盔、定期检查刹车，并且不要在骑行时戴耳机。"),
            ("en-AU-NatashaNeural", "On rainy mornings, keeping a light waterproof jacket in your backpack solves most excuses.", "遇到下雨的清晨，书包里备一件轻便防水外套就能解决大多数不便。"),
            ("en-AU-NatashaNeural", "You also learn the rhythm of your neighborhood, noticing new shops and changing trees.", "你还会熟悉周边街区的节奏，留意到新开的小店和四季变换的树木。"),
            ("en-AU-NatashaNeural", "When schools encourage green commuting, students see climate action as part of daily life.", "当学校鼓励绿色通勤时，学生们也会把环保行动看作日常生活的一部分。"),
            ("en-AU-NatashaNeural", "Perhaps the best journey to class is the one powered simply by your own two pedals.", "或许通往教室最棒的一段路，就是全凭自己双脚蹬出的那一段风景。"),
        ],
    },
    {
        "slug": "l2_06_solo_train_trip",
        "tier": "L2",
        "name": "[L2] 旅行见闻 · 第一次独自坐火车旅行",
        "rate": "-6%",
        "gap_sec": 0.38,
        "sentences": [
            ("en-GB-RyanNeural", "Last summer, I took my first solo train journey to visit my cousin by the coast.", "去年夏天，我第一次独自乘坐火车，去海边看望我的表哥。"),
            ("en-GB-RyanNeural", "At the crowded station, I checked the departure board three times to confirm my platform.", "在人来人往的车站里，我把发车大屏确认了三遍才核对好站台。"),
            ("en-GB-RyanNeural", "Once I found my window seat and stored my bag, the early nervousness faded away.", "一等我找到靠窗座位并放好行李，最初的紧张感就消散了。"),
            ("en-GB-RyanNeural", "As the train left the city, grey buildings gave way to green fields and quiet hills.", "随着列车驶离城市，灰色的建筑群逐渐退去，取而代之的是绿野与宁静的山丘。"),
            ("en-GB-RyanNeural", "Across the aisle, an elderly couple shared oranges and told stories about old towns nearby.", "过道对面，一对老夫妇分给我几瓣橘子，还聊起附近几座老镇的往事。"),
            ("en-GB-RyanNeural", "Unlike flying, a train lets you watch the landscape change slowly mile by mile.", "和坐飞机不同，坐火车能让你一英里接一英里地看着沿途地貌慢慢变换。"),
            ("en-GB-RyanNeural", "Halfway through the trip, the train paused briefly at a tiny station covered in ivy.", "旅途中半程时，列车在一个爬满常春藤的小站短暂停靠。"),
            ("en-GB-RyanNeural", "I spent the next hour reading my novel while listening to rain tap against the glass.", "接下来的一个小时，我听着雨点敲打车窗，安静地读着带来的小说。"),
            ("en-GB-RyanNeural", "Just before sunset, a thin blue line of sea appeared beyond the tall grass.", "就在日落前不久，高草丛的远方出现了一道淡蓝色的海平线。"),
            ("en-GB-RyanNeural", "Stepping onto the platform alone made me realize I was more capable than I thought.", "独自踏上站台的那一刻，我意识到自己比想象中更有独立应对的能力。"),
            ("en-GB-RyanNeural", "Sometimes traveling by yourself does not feel lonely; it simply leaves room to notice more.", "有时候一个人旅行并不孤单，它只是给你留出了空间去留意更多风景。"),
            ("en-GB-RyanNeural", "That three-hour ride taught me to plan carefully while staying open to pleasant surprises.", "那趟三小时的车程教会了我提前做好规划，同时也欣然迎接旅途中的小惊喜。"),
        ],
    },
    {
        "slug": "l2_07_ai_english_study",
        "tier": "L2",
        "name": "[L2] 科技应用 · 用 AI 辅助英语学习",
        "rate": "-6%",
        "gap_sec": 0.38,
        "sentences": [
            ("en-US-JennyNeural", "Have you used any voice tools to practice spoken English outside class recently?", "你最近有没有用什么语音工具在课外练习英语口语？"),
            ("en-US-AndrewNeural", "Yes, I started chatting with an AI partner for fifteen minutes after dinner.", "有啊，我最近开始每天晚饭后跟 AI 陪练聊上十五分钟。"),
            ("en-US-JennyNeural", "Does it actually help, or does talking to a computer still feel awkward?", "那真的有用吗，还是对着电脑开口说话还是会觉得尴尬？"),
            ("en-US-AndrewNeural", "At first it felt odd, yet I realized nobody is judging my grammar mistakes.", "一开始确实有点别扭，但我很快发现根本没人会评判我的语法错误。"),
            ("en-US-JennyNeural", "True! In class I often stay quiet because I worry about sounding unnatural.", "太真实了！在课堂上我常常不敢开口，就怕自己说得不够地道。"),
            ("en-US-AndrewNeural", "Exactly. Now I practice ordering food, job interviews, or explaining hobbies aloud.", "没错。我现在会大声练习点餐、面试，或者用英语介绍自己的兴趣爱好。"),
            ("en-US-JennyNeural", "How do you make sure you are learning better phrasing instead of repeating errors?", "那你怎么确保自己能学到更地道的表达，而不是一直在重复老毛病呢？"),
            ("en-US-AndrewNeural", "After each chat, I ask it to point out two clumsy phrases and suggest natural upgrades.", "每次聊完后，我都会让它挑出两处不够自然的表达，并给出地道替换说法。"),
            ("en-US-JennyNeural", "That is smart! Do you write those expressions down somewhere?", "这办法真聪明！你会把那些地道表达记下来吗？"),
            ("en-US-AndrewNeural", "Yes, I save my favorite lines and replay them during short listening breaks.", "会的，我把常用的句子收藏起来，在休息碎片时间再回放听几遍。"),
            ("en-US-JennyNeural", "Pairing listening practice with real speaking clearly builds fluency much faster.", "把听力输入和真实开口输出结合起来，流利度确实提升得快得多。"),
            ("en-US-AndrewNeural", "Totally. Try picking one everyday topic tonight and speaking for just five minutes.", "绝对的。今晚就可以选一个日常话题，试着开口讲上五分钟。"),
        ],
    },
    {
        "slug": "l2_08_evening_walk",
        "tier": "L2",
        "name": "[L2] 运动健康 · 晚间快走如何改善睡眠",
        "rate": "-6%",
        "gap_sec": 0.38,
        "sentences": [
            ("en-US-AriaNeural", "After sitting at a desk for hours, it is common to feel restless at bedtime.", "在书桌前久坐了好几个小时之后，临睡前常常会觉得心里静不下来。"),
            ("en-US-AriaNeural", "Your eyes may feel heavy, yet your brain keeps replaying unfinished tasks from school.", "眼皮或许已经很沉重了，可大脑却还在反复回想学校里没做完的事情。"),
            ("en-US-AriaNeural", "Taking a twenty-minute brisk walk after dinner offers a simple bridge into deeper rest.", "晚饭后快走二十分钟，能为你搭起一座通往深度休息的温和桥梁。"),
            ("en-US-AriaNeural", "Gentle movement releases built-up tension in your shoulders and helps steady your breathing.", "适度运动能释放肩颈积累的紧绷感，并让呼吸逐渐平稳下来。"),
            ("en-US-AriaNeural", "Doctors suggest finishing exercise at least ninety minutes before your planned sleep time.", "医生建议至少在计划入睡前九十分钟结束运动。"),
            ("en-US-AriaNeural", "That gap lets your body temperature cool naturally, signaling that night has begun.", "这段间隔能让体温自然下降，向身体发出夜晚已经开始的信号。"),
            ("en-US-AriaNeural", "Try walking along a well-lit park path instead of checking study forums on your phone.", "试着沿着灯光明亮的公园小路走一走，别一边走一边刷手机上的学习帖子。"),
            ("en-US-AriaNeural", "You can bring a classmate to chat lightly, or enjoy listening to calm music along the way.", "你可以约个同学轻松聊几句，或者沿途听听舒缓的音乐。"),
            ("en-US-AriaNeural", "Even moderate exercise improves mood by boosting natural chemicals that reduce daily stress.", "哪怕是中等强度的运动，也能促进缓解压力的物质分泌，改善情绪。"),
            ("en-US-AriaNeural", "Many walkers notice they fall asleep faster and wake up less often during the night.", "许多坚持散步的人发现，自己入睡更快了，半夜醒来的次数也变少了。"),
            ("en-US-AriaNeural", "Better sleep then returns the favor by sharpening your memory for morning classes.", "更高质量的睡眠随后又会反过来回报你，让早上上课时的记忆力更敏锐。"),
            ("en-US-AriaNeural", "You do not need a gym membership to care for your energy every single evening.", "想要每晚好好呵护自己的精力，你其实并不需要一张健身房会员卡。"),
        ],
    },
    {
        "slug": "l2_09_paper_vs_ebook",
        "tier": "L2",
        "name": "[L2] 社会观察 · 纸质书与电子书怎么选",
        "rate": "-6%",
        "gap_sec": 0.38,
        "sentences": [
            ("en-GB-SoniaNeural", "Do you still buy paper textbooks, or have you moved all your reading onto a tablet?", "你现在还会买纸质书吗，还是已经把阅读全搬到平板电脑上了？"),
            ("en-GB-RyanNeural", "Honestly, I use both depending on what I am reading and where I am sitting.", "说实话，我两种都会用，取决于当时在读什么以及身处哪里。"),
            ("en-GB-SoniaNeural", "What makes you reach for an electronic file over a printed copy?", "什么情况下你会更倾向于打开电子版而不是纸质书？"),
            ("en-GB-RyanNeural", "When I travel or commute, carrying five heavy novels inside one slim tablet saves my back.", "出远门或通勤时，把五本厚小说装进一台轻薄平板里，能省下不少背负的力气。"),
            ("en-GB-SoniaNeural", "Plus, searching a keyword or tapping an unfamiliar word for a definition takes one second.", "而且搜索关键词，或者点一下生词查释义，只要一秒钟。"),
            ("en-GB-RyanNeural", "True, yet for exam revision and deep study, I still trust paper books far more.", "没错，但如果涉及考试复习和深度精读，我还是更信赖纸质书。"),
            ("en-GB-SoniaNeural", "Why does paper feel easier to remember? Is it just habit?", "为什么纸质书感觉更容易记住？单纯只是个人习惯吗？"),
            ("en-GB-RyanNeural", "Studies suggest flipping pages gives your memory physical clues, like top-left or bottom-right.", "研究显示，翻页的过程能为记忆提供空间线索，比如记起某句话在左上角还是右下角。"),
            ("en-GB-SoniaNeural", "And there are no pop-up messages inviting you to check social media every chapter.", "而且读完一章时，也不会有弹窗消息诱惑你点开社交软件。"),
            ("en-GB-RyanNeural", "Exactly. Scribbling short notes in the margin also helps ideas stick in my head.", "对极了，在书页空白处顺手写几句批注，也能让观点在脑海里留得更牢。"),
            ("en-GB-SoniaNeural", "So e-books win on convenience, while printed pages support slower, deeper attention.", "这么看来，电子书胜在便携高效，而纸质书更适合慢下来深度专注。"),
            ("en-GB-RyanNeural", "Right—using each format for its strengths is much better than picking only one side.", "是的，各自发挥长处，远比非此即彼要实用得多。"),
        ],
    },
    {
        "slug": "l2_10_library_volunteer",
        "tier": "L2",
        "name": "[L2] 个人成长 · 社区图书馆志愿者的周末",
        "rate": "-6%",
        "gap_sec": 0.38,
        "sentences": [
            ("en-US-JennyNeural", "Every Saturday morning at nine, Maya puts on a blue volunteer badge at her local library.", "每周六上午九点，玛雅都会在社区图书馆别上蓝色的志愿者工牌。"),
            ("en-US-JennyNeural", "At first, she signed up mainly to complete the community service hours for school.", "起初，她报名参加主要是为了完成学校要求的社区服务时长。"),
            ("en-US-JennyNeural", "Her first tasks seemed simple: sorting returned books onto carts and tidying quiet tables.", "她最初的工作看起来很简单：把归还的图书分拣推车，整理干净安静的阅览桌。"),
            ("en-US-JennyNeural", "Soon, she started helping younger kids find illustrated science books near the front desk.", "很快，她开始帮低年级的小朋友在前台附近寻找带插图的科普读物。"),
            ("en-US-JennyNeural", "An elderly neighbor also asked Maya every week to recommend warm mystery stories.", "还有一位住在附近的老人每周都会请玛雅推荐几本节奏舒缓的悬疑小说。"),
            ("en-US-JennyNeural", "Through those brief chats, Maya learned to listen patiently before offering suggestions.", "透过这些简短的交流，玛雅学会了在给出建议前先耐心倾听对方需求。"),
            ("en-US-JennyNeural", "Last month, the head librarian invited her to help run a Sunday story corner.", "上个月，馆长还邀请她协助主持周日的故事角活动。"),
            ("en-US-JennyNeural", "Preparing props and reading aloud clearly boosted her confidence in front of groups.", "提前准备小道具并大声朗读故事，让她在人群面前讲话的自信心明显增强了。"),
            ("en-US-JennyNeural", "She also discovered how much effort staff spend organizing free community classes.", "她还体会到馆员们为了组织免费社区课程付出了多少细致工作。"),
            ("en-US-JennyNeural", "Even after finishing her required school hours, Maya decided to stay on through spring.", "即便早就修满了学校要求的志愿时长，玛雅还是决定继续留任到春天结束。"),
            ("en-US-JennyNeural", "Volunteering turned out not to be one-way help; it connected her with neighbors of all ages.", "志愿服务原来并非单方面的付出，它把她和各个年龄层的邻居联系在了一起。"),
            ("en-US-JennyNeural", "Giving back a few hours on weekends gave her weekdays a stronger sense of purpose.", "周末奉献出的几个小时，让她在平日的学习生活中也多了一份踏实的目标感。"),
        ],
    },
    {
        "slug": "l2_11_monthly_budget",
        "tier": "L2",
        "name": "[L2] 生活理财 · 高中生的第一份月度预算",
        "rate": "-6%",
        "gap_sec": 0.38,
        "sentences": [
            ("en-AU-NatashaNeural", "Did your allowance disappear faster than expected again before the end of this month?", "这个月还没到月底，你的零花钱是不是又比预想中花得更快了？"),
            ("en-US-GuyNeural", "Every single time! By the twentieth, I have no idea where half of it went.", "每次都是这样！一到二十号，我根本想不起来一半的钱都花到哪儿去了。"),
            ("en-AU-NatashaNeural", "Small purchases like iced drinks, snacks, and bus rides add up quietly.", "冰饮、零食和公交车费这些不起眼的小开销，往往会悄悄累积起来。"),
            ("en-US-GuyNeural", "So how do you keep track without turning every snack into a math test?", "那你怎么做到心中有数，又不用每次买零食都像在做数学题呢？"),
            ("en-AU-NatashaNeural", "At the start of the month, I divide my money into three simple buckets.", "月初拿到钱时，我会把零花钱分成简简单单的三份。"),
            ("en-US-GuyNeural", "Three buckets? Let me guess: food, fun, and books?", "分成三份？我猜猜看：吃饭、娱乐和买书？"),
            ("en-AU-NatashaNeural", "Close! First is daily needs like lunch and transit, second is weekend fun, third is savings.", "猜得很接近！第一份是午餐交通等日常必需，第二份是周末娱乐，第三份是储蓄。"),
            ("en-US-GuyNeural", "How much do you move into savings right when the month begins?", "那你在月初会立刻把多少比例存进储蓄那一份？"),
            ("en-AU-NatashaNeural", "Just ten percent, before I spend anything else, so it never gets forgotten.", "只存百分之十，在花任何钱之前先拨出来，这样就不会忘记攒钱。"),
            ("en-US-GuyNeural", "And if the fun bucket runs empty early, you wait until next month?", "那要是娱乐那一份提前花完了，你就等到下个月再说吗？"),
            ("en-AU-NatashaNeural", "Yes, waiting twenty-four hours before buying trendy items saves me from impulse shopping.", "是的，买热门东西前先等二十四小时冷静一下，能帮我躲开很多冲动消费。"),
            ("en-US-GuyNeural", "That sounds surprisingly doable. I am setting up my three buckets on Friday.", "听起来比想象中容易坚持，我这周五就按你说的分好这三份预算。"),
        ],
    },
    {
        "slug": "l2_12_corner_cafe",
        "tier": "L2",
        "name": "[L2] 文化日常 · 街角咖啡馆的松弛感",
        "rate": "-6%",
        "gap_sec": 0.38,
        "sentences": [
            ("en-GB-LibbyNeural", "On almost every quiet side street in London, you can find a small independent cafe.", "在伦敦几乎每一条安静的小街上，都能找到一间小小的独立咖啡馆。"),
            ("en-GB-LibbyNeural", "Unlike huge busy chains, these corner shops move at a gentler human pace.", "与人流匆匆的大型连锁店不同，这些街角小店保持着更从容的生活节奏。"),
            ("en-GB-LibbyNeural", "Morning regulars often do not even need to order; the owner already knows their drink.", "早上的常客甚至常常不用开口点单，店主早就记住了他们常喝的那一款。"),
            ("en-GB-LibbyNeural", "Wooden tables near the window catch pale morning light and invite people to linger.", "靠窗的木桌沐浴在清晨柔和的阳光里，让人忍不住想多坐一会儿。"),
            ("en-GB-LibbyNeural", "Students bring notebooks to sketch essays, while neighbors trade quick weather jokes at the counter.", "学生们带着笔记本在桌边起草文章，邻居们则在吧台前顺口调侃几句天气。"),
            ("en-GB-LibbyNeural", "Nobody rushes you out after finishing a single cup of tea or flat white.", "就算只点了一杯茶或澳白，也没人会催着你匆忙离开。"),
            ("en-GB-LibbyNeural", "The background mix of soft jazz, steaming milk, and quiet pages creates natural calm.", "轻柔的爵士乐、打奶泡的蒸汽声与翻书声交织在一起，营造出自然的宁静感。"),
            ("en-GB-LibbyNeural", "Sociologists sometimes call spaces like these a 'third place' between home and school.", "社会学家有时把这样的空间称为介于家庭和学校之间的“第三空间”。"),
            ("en-GB-LibbyNeural", "You are surrounded by friendly company, yet nobody asks you to perform or hurry.", "身边有温暖的人气陪伴，但又没有人要求你去迎合或赶时间。"),
            ("en-GB-LibbyNeural", "Even half an hour there helps people step back and reset their mood after exams.", "哪怕只在那里待上半小时，也能帮人在考试或忙碌后调整心情。"),
            ("en-GB-LibbyNeural", "Every city needs small corners where time stretches out and conversations stay unhurried.", "每座城市都需要这样一个小角落，让时间舒展开来，让交谈不慌不忙。"),
            ("en-GB-LibbyNeural", "Next time you pass a cozy cafe, leave your phone tucked away and enjoy the pause.", "下次路过一间温馨的小咖啡馆时，不妨收起手机，好好享受片刻的停顿。"),
        ],
    },
]


async def synth_sentence(sem: asyncio.Semaphore, text: str, voice: str, rate: str, mp3_out: pathlib.Path, wav_out: pathlib.Path) -> int:
    """Synthesize a single sentence via edge_tts with retries and transcode to mono 24kHz PCM WAV."""
    last_err = None
    for attempt in range(4):
        try:
            async with sem:
                comm = edge_tts.Communicate(text, voice, rate=rate)
                await comm.save(str(mp3_out))
            subprocess.run(
                [FFMPEG, "-y", "-v", "error", "-i", str(mp3_out), "-ar", str(SAMPLE_RATE), "-ac", "1", "-c:a", "pcm_s16le", str(wav_out)],
                check=True,
            )
            with wave.open(str(wav_out), "rb") as w:
                frames = w.getnframes()
            if frames > 0:
                return frames
        except Exception as exc:
            last_err = exc
            await asyncio.sleep(0.8 * (2 ** attempt))
    raise RuntimeError(f"Failed to synthesize {text!r}: {last_err}")


async def build_material(sem: asyncio.Semaphore, item: dict) -> dict:
    MATERIALS_DIR.mkdir(parents=True, exist_ok=True)
    LIBRARY_DIR.mkdir(parents=True, exist_ok=True)

    slug = item["slug"]
    name = item["name"]
    rate = item["rate"]
    gap_sec = item["gap_sec"]
    pid = str(uuid.uuid5(uuid.NAMESPACE_URL, f"aboboo-library:lirio-{slug}"))
    tid = str(uuid.uuid5(uuid.NAMESPACE_URL, f"{pid}:audio"))

    mp3_target = MATERIALS_DIR / f"{slug}.mp3"

    with tempfile.TemporaryDirectory(prefix=f"lirio_{slug}_") as tmp_dir:
        tmp = pathlib.Path(tmp_dir)
        # Synthesize all sentences for this item concurrently
        tasks = []
        for idx, (voice, text, _zh) in enumerate(item["sentences"]):
            tasks.append(
                synth_sentence(
                    sem,
                    text,
                    voice,
                    rate,
                    tmp / f"s_{idx:02d}.mp3",
                    tmp / f"s_{idx:02d}.wav",
                )
            )
        frame_counts = await asyncio.gather(*tasks)

        lead_frames = int(round(0.20 * SAMPLE_RATE))
        gap_frames = int(round(gap_sec * SAMPLE_RATE))
        tail_frames = int(round(0.30 * SAMPLE_RATE))

        combined_wav = tmp / "combined.wav"
        timings = []
        cursor_frames = lead_frames

        with wave.open(str(combined_wav), "wb") as out_w:
            out_w.setnchannels(1)
            out_w.setsampwidth(2)
            out_w.setframerate(SAMPLE_RATE)
            out_w.writeframes(b"\x00" * (lead_frames * 2))

            for idx, nframes in enumerate(frame_counts):
                start_sec = round(cursor_frames / SAMPLE_RATE, 3)
                end_sec = round((cursor_frames + nframes) / SAMPLE_RATE, 3)
                timings.append((start_sec, end_sec))
                with wave.open(str(tmp / f"s_{idx:02d}.wav"), "rb") as in_w:
                    out_w.writeframes(in_w.readframes(nframes))
                cursor_frames += nframes
                if idx < len(frame_counts) - 1:
                    out_w.writeframes(b"\x00" * (gap_frames * 2))
                    cursor_frames += gap_frames

            out_w.writeframes(b"\x00" * (tail_frames * 2))

        mp3_tmp = mp3_target.with_name(f".tmp_{mp3_target.name}")
        subprocess.run(
            [FFMPEG, "-y", "-v", "error", "-i", str(combined_wav), "-ar", str(SAMPLE_RATE), "-ac", "1", "-b:a", "64k", "-f", "mp3", str(mp3_tmp)],
            check=True,
        )
        mp3_tmp.replace(mp3_target)

    probe = subprocess.check_output(
        [FFPROBE, "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", str(mp3_target)],
        text=True,
    ).strip()
    duration = float(probe)

    sentences_payload = []
    for idx, ((_voice, text, zh), (start_sec, end_sec)) in enumerate(zip(item["sentences"], timings)):
        clamped_end = min(end_sec, round(duration, 3))
        assert 0 <= start_sec < clamped_end <= duration + 1e-6, f"{slug} bad sentence {idx}: {start_sec}..{clamped_end} / {duration}"
        sentences_payload.append(
            {
                "id": str(uuid.uuid5(uuid.NAMESPACE_URL, f"{pid}:sent:{idx}")),
                "start": start_sec,
                "end": clamped_end,
                "text": text,
                "translation": zh,
                "answer": "",
                "submitted": False,
                "revealed": False,
                "attempts": 0,
            }
        )

    for i in range(len(sentences_payload) - 1):
        assert sentences_payload[i]["end"] <= sentences_payload[i + 1]["start"] + 0.001

    mp3_bytes = mp3_target.read_bytes()
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    doc = {
        "format": "aboboo-community-v1",
        "id": pid,
        "name": name,
        "duration": duration,
        "originalAudioPath": str(mp3_target),
        "libraryId": pid,
        "tracks": [
            {
                "id": tid,
                "type": "original",
                "name": "Original",
                "audioPath": str(mp3_target),
                "startTime": 0,
                "duration": duration,
                "volume": 1,
                "muted": False,
            }
        ],
        "metadata": {"createdAt": now, "updatedAt": now},
        "dictation": {
            "sentences": sentences_payload,
            "index": 0,
            "source": "lirio-graded-tts",
            "words": [],
            "segmentationVersion": 2,
        },
        "favorites": [],
        "embeddedAudio": {
            tid: {
                "data": base64.b64encode(mp3_bytes).decode("ascii"),
                "mime": "audio/mpeg",
            }
        },
    }

    abmac_path = LIBRARY_DIR / f"{pid}.abmac"
    abmac_tmp = LIBRARY_DIR / f"{pid}.{uuid.uuid4()}.tmp"
    abmac_tmp.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
    abmac_tmp.replace(abmac_path)

    # Preserve completed/favorites count if user has existing .progress.json
    completed_cnt = 0
    fav_cnt = 0
    prog_path = LIBRARY_DIR / f"{pid}.progress.json"
    if prog_path.is_file():
        try:
            prog = json.loads(prog_path.read_text(encoding="utf-8"))
            ss_prog = prog.get("dictation", {}).get("sentences") or []
            completed_cnt = sum(1 for s in ss_prog if s.get("submitted") is True)
            fav_cnt = len(prog.get("favorites") or [])
        except Exception:
            pass

    meta = {
        "id": pid,
        "name": name,
        "duration": duration,
        "sentenceCount": len(sentences_payload),
        "completed": completed_cnt,
        "favorites": fav_cnt,
    }
    meta_path = LIBRARY_DIR / f"{pid}.meta.json"
    meta_tmp = LIBRARY_DIR / f"{pid}.meta.{uuid.uuid4()}.tmp"
    meta_tmp.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    meta_tmp.replace(meta_path)

    print(f"OK [{item['tier']}] {name} -> {len(sentences_payload)} 句, {duration:.1f}s ({len(mp3_bytes)//1024} KB)", flush=True)
    return meta


async def main():
    sem = asyncio.Semaphore(6)
    results = []
    # Build sequentially per item (with 6 concurrent sentence TTS calls inside each item)
    for item in MATERIALS:
        meta = await build_material(sem, item)
        results.append(meta)
    print(f"\nDONE: generated {len(results)} graded L1/L2 materials.", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
