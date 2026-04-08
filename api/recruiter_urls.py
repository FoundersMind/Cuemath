from django.contrib.auth import views as auth_views
from django.urls import path

from api import recruiter_views

urlpatterns = [
    path(
        "login/",
        auth_views.LoginView.as_view(template_name="recruiter/login.html"),
        name="recruiter_login",
    ),
    path(
        "logout/",
        auth_views.LogoutView.as_view(next_page="/recruiter/login/"),
        name="recruiter_logout",
    ),
    path("", recruiter_views.dashboard, name="recruiter_dashboard"),
    path("sessions/<uuid:pk>/", recruiter_views.session_detail, name="recruiter_session_detail"),
]
