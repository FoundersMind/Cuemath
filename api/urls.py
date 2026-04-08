from django.urls import path

from api import views

urlpatterns = [
    path("health", views.health),
    path("session/create", views.session_create),
    path("interview/start", views.interview_start),
    path("interview/start-stream", views.interview_start_stream),
    path("interview/message", views.interview_message),
    path("interview/message-stream", views.interview_message_stream),
    path("interview/assess", views.interview_assess),
    path("transcribe", views.transcribe),
    path("tts", views.tts_speak),
    path("report/pdf", views.report_pdf),
]
