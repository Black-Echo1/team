// 1. توليد الفيديوهات تلقائياً بناءً على الصفحة
document.addEventListener("DOMContentLoaded", () => {
    const grid = document.getElementById("video-grid");
    
    if (grid) {
        const category = grid.getAttribute("data-category");
        const videos = videosData[category] || [];
        
        videos.forEach(video => {
            // رابط التحميل المباشر من درايف (يبدأ التحميل فوراً بدون صفحة مشاهدة)
            const downloadLink = `https://drive.google.com/uc?export=download&id=${video.driveId}`;
            
            const cardHTML = `
                <div class="video-card">
                    <div class="smart-thumbnail" onclick="triggerAdAndPlay('${video.driveId}')">
                        <img src="${video.thumbnail}" alt="${video.title}">
                        <div class="play-overlay">▶ تشغيل</div>
                    </div>
                    <h3>${video.title}</h3>
                    <a href="${downloadLink}" class="download-btn">تحميل الجودة الأصلية</a>
                </div>
            `;
            grid.innerHTML += cardHTML;
        });
    }
});

// 2. نظام الإعلانات وتشغيل الفيديو
let currentDriveId = "";
let adTimer;

function triggerAdAndPlay(driveId) {
    currentDriveId = driveId;
    let adModal = document.getElementById("adModal");
    let closeAdBtn = document.querySelector(".close-ad");
    let countdownElement = document.getElementById("countdown");

    if(adModal) {
        adModal.style.display = "flex";
        closeAdBtn.style.display = "none";
        
        let timeLeft = 5; 
        countdownElement.innerText = timeLeft;

        adTimer = setInterval(function() {
            timeLeft--;
            countdownElement.innerText = timeLeft;
            
            if (timeLeft <= 0) {
                clearInterval(adTimer);
                closeAdBtn.style.display = "block";
            }
        }, 1000);
    }
}

function openVideo() {
    document.getElementById("adModal").style.display = "none";
    let videoModal = document.getElementById("videoModal");
    let videoFrame = document.getElementById("mainVideoFrame");
    
    if(videoModal && videoFrame) {
        videoModal.style.display = "flex";
        // دمج الـ ID في رابط المشاهدة الخاص بدرايف
        videoFrame.src = `https://drive.google.com/file/d/${currentDriveId}/preview`;
    }
}

function closeVideo() {
    let videoModal = document.getElementById("videoModal");
    let videoFrame = document.getElementById("mainVideoFrame");
    
    if(videoModal && videoFrame) {
        videoModal.style.display = "none";
        videoFrame.src = ""; // إيقاف تشغيل الفيديو والصوت فوراً
    }
}